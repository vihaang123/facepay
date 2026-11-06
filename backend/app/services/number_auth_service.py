"""Sign-up and sign-in with a mobile number and a 6-digit app passcode.

Honest limits, all of which the UI repeats:
- FacePay cannot send SMS, so the one-time code at sign-up is a DEMO code shown on screen. It proves nothing about who holds the
  SIM, so it is never what protects an account. The passcode is, and payments still need the face check.
- A 6-digit passcode is only safe because of the lock: 5 wrong tries lock the number for 15 minutes. That lock can be used to
  annoy someone whose number you know; that is accepted for a prototype, and it is the reason the lock is per number, not global.
- The passcode is HMAC'd with a server secret before it is hashed, so a copy of the database alone cannot be brute forced.
- Nothing here talks to a bank, UPI or an SMS provider.
"""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import mobile as mobile_rules
from app.core.config import get_settings
from app.core.security import hash_password, password_needs_rehash, verify_password
from app.models import Merchant, MobileNumber, OtpChallenge, SigninAttempt, User
from app.schemas.number_auth import NumberSignup
from app.services import facepay_service

RESEND_SECONDS = 30
_ISSUE_WINDOW = timedelta(minutes=10)
_ISSUE_MAX = 5


class NumberAlreadyRegistered(Exception):
    pass


class OtpNotAllowed(Exception):
    """Demo codes are switched off, or too many were asked for."""

    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class OtpInvalid(Exception):
    pass


class InvalidCredentials(Exception):
    pass


class AccountDisabled(Exception):
    pass


class SigninLocked(Exception):
    def __init__(self, minutes: int):
        super().__init__(f"locked for {minutes} minutes")
        self.minutes = minutes


class NotAgreed(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _secret() -> bytes:
    return get_settings().jwt_secret.encode()


def _mac(*parts: str) -> str:
    return hmac.new(_secret(), "|".join(parts).encode(), hashlib.sha256).hexdigest()


def _peppered(mobile: str, passcode: str) -> str:
    return _mac("passcode", mobile, passcode)


def owner_of(db: Session, mobile: str) -> User | Merchant | None:
    row = db.get(MobileNumber, mobile)
    if row is None:
        return None
    return db.get(User, row.user_id) if row.user_id is not None else db.get(Merchant, row.merchant_id)


# ---- one-time (demo) codes -------------------------------------------------------------------------------------------------


def issue_otp(db: Session, mobile: str, purpose: str) -> tuple[OtpChallenge, str]:
    settings = get_settings()
    if not settings.demo_otp_enabled:
        raise OtpNotAllowed("Sign-up by mobile number is not available: no SMS provider is configured.", 503)
    if purpose == "signup" and db.get(MobileNumber, mobile) is not None:
        raise NumberAlreadyRegistered
    if purpose == "claim" and db.get(MobileNumber, mobile) is not None:
        raise NumberAlreadyRegistered
    now = _now()
    recent = db.scalars(
        select(OtpChallenge.created_at).where(OtpChallenge.mobile == mobile, OtpChallenge.created_at > now - _ISSUE_WINDOW)
        .order_by(OtpChallenge.created_at.desc())
    ).all()
    if len(recent) >= _ISSUE_MAX:
        raise OtpNotAllowed("Too many codes requested for this number. Try again in a few minutes.", 429)
    if recent and (now - recent[0]).total_seconds() < RESEND_SECONDS:
        raise OtpNotAllowed(f"Wait {RESEND_SECONDS} seconds before asking for another code.", 429)
    code = f"{secrets.randbelow(10**6):06d}"
    challenge_id = secrets.token_urlsafe(24)
    row = OtpChallenge(
        challenge_id=challenge_id,
        mobile=mobile,
        code_hash=_mac("otp", challenge_id, code),
        expires_at=now + timedelta(seconds=settings.otp_ttl_seconds),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row, code


def verify_otp(db: Session, challenge_id: str, code: str) -> OtpChallenge:
    row = db.scalar(select(OtpChallenge).where(OtpChallenge.challenge_id == challenge_id).with_for_update())
    now = _now()
    if row is None or row.consumed_at is not None or row.expires_at <= now or row.attempts >= get_settings().otp_max_attempts:
        raise OtpInvalid
    if row.verified_at is not None:
        return row
    if not hmac.compare_digest(row.code_hash, _mac("otp", challenge_id, code)):
        row.attempts += 1
        db.commit()
        raise OtpInvalid
    row.verified_at = now
    db.commit()
    return row


def _take_verified(db: Session, challenge_id: str, mobile: str | None = None) -> OtpChallenge:
    """Lock and return a verified, unused, unexpired challenge. It is single use: the caller marks it consumed in its own commit."""
    row = db.scalar(select(OtpChallenge).where(OtpChallenge.challenge_id == challenge_id).with_for_update())
    if (
        row is None
        or row.verified_at is None
        or row.consumed_at is not None
        or row.expires_at + timedelta(minutes=10) <= _now()  # a verified code stays usable a little longer for filling the form
        or (mobile is not None and row.mobile != mobile)
    ):
        raise OtpInvalid
    return row


# ---- sign up ---------------------------------------------------------------------------------------------------------------


def sign_up(db: Session, data: NumberSignup) -> tuple[User | Merchant, str]:
    if not data.agreed:
        raise NotAgreed
    challenge = _take_verified(db, data.challenge_id)
    mobile = challenge.mobile
    if db.get(MobileNumber, mobile) is not None:
        raise NumberAlreadyRegistered
    pass_hash = hash_password(_peppered(mobile, data.passcode))
    if data.account_type == "merchant":
        account: User | Merchant = Merchant(
            name=data.name, business_name=data.business_name or data.name, mobile=mobile, passcode_hash=pass_hash,
            email=None, password_hash=hash_password(secrets.token_urlsafe(32)),
        )
        kind = "merchant"
        db.add(account)
        try:
            db.flush()
            db.add(MobileNumber(mobile=mobile, account_type="merchant", merchant_id=account.id))
            challenge.consumed_at = _now()
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise NumberAlreadyRegistered from exc
        db.refresh(account)
        return account, kind
    for _ in range(6):
        account = User(
            name=data.name, phone=mobile, mobile=mobile, passcode_hash=pass_hash, email=None,
            # Number accounts have no email password. The column is NOT NULL, so it holds a random hash nobody knows.
            password_hash=hash_password(secrets.token_urlsafe(32)),
            facepay_id=facepay_service.generate_unique(db, data.name),
        )
        db.add(account)
        try:
            db.flush()
            db.add(MobileNumber(mobile=mobile, account_type="user", user_id=account.id))
            challenge.consumed_at = _now()
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            if db.get(MobileNumber, mobile) is not None:
                raise NumberAlreadyRegistered from exc
            challenge = _take_verified(db, data.challenge_id)  # the FacePay ID was taken meanwhile: try another
            continue
        db.refresh(account)
        return account, "customer"
    raise RuntimeError("could not allocate a unique FacePay ID")


# ---- sign in ---------------------------------------------------------------------------------------------------------------


def _attempt_row(db: Session, mobile: str) -> SigninAttempt:
    db.execute(pg_insert(SigninAttempt).values(mobile=mobile).on_conflict_do_nothing())
    return db.scalar(select(SigninAttempt).where(SigninAttempt.mobile == mobile).with_for_update())


def sign_in(db: Session, mobile: str, passcode: str) -> tuple[User | Merchant, str]:
    settings = get_settings()
    attempt = _attempt_row(db, mobile)
    now = _now()
    if attempt.locked_until is not None and attempt.locked_until > now:
        db.rollback()
        raise SigninLocked(max(1, int((attempt.locked_until - now).total_seconds() // 60) + 1))
    account = owner_of(db, mobile)
    stored = account.passcode_hash if account is not None else None
    # Always run one verification, known number or not, so timing does not reveal which numbers have accounts.
    ok = verify_password(_peppered(mobile, passcode), stored)  # None burns the same time and is always False
    if not ok:
        attempt.failed_count += 1
        attempt.updated_at = now
        if attempt.failed_count >= settings.signin_max_failures:
            attempt.locked_until = now + timedelta(minutes=settings.signin_lock_minutes)
            attempt.failed_count = 0
        db.commit()
        raise InvalidCredentials
    attempt.failed_count = 0
    attempt.locked_until = None
    if isinstance(account, User) and account.status != "active":
        db.commit()
        raise AccountDisabled
    if password_needs_rehash(account.passcode_hash):
        account.passcode_hash = hash_password(_peppered(mobile, passcode))
    db.commit()
    if isinstance(account, Merchant):
        return account, "merchant"
    return account, account.role


# ---- an older (email) account adds its number -------------------------------------------------------------------------------


def claim_number(db: Session, account: User | Merchant, challenge_id: str, passcode: str) -> None:
    if account.mobile is not None:
        raise NumberAlreadyRegistered  # one number per account; changing it is not offered in this prototype
    challenge = _take_verified(db, challenge_id)
    mobile = challenge.mobile
    if db.get(MobileNumber, mobile) is not None:
        raise NumberAlreadyRegistered
    account.mobile = mobile
    account.passcode_hash = hash_password(_peppered(mobile, passcode))
    if isinstance(account, User):
        db.add(MobileNumber(mobile=mobile, account_type="user", user_id=account.id))
        if not account.phone:
            account.phone = mobile
    else:
        db.add(MobileNumber(mobile=mobile, account_type="merchant", merchant_id=account.id))
    challenge.consumed_at = _now()
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise NumberAlreadyRegistered from exc


def purge_old(db: Session) -> None:
    """Housekeeping, called when a code is asked for: expired codes older than a day are of no use to anyone."""
    db.query(OtpChallenge).filter(OtpChallenge.expires_at < _now() - timedelta(days=1)).delete()
    db.commit()
