"""Account security around face payments: lockout, payment PIN, risk-based step-up, limits, audit events.

Face recognition is never payment authorization on its own. Authorization is a separate, per-payment, single-use
ticket (payment_service); this module supplies the checks around it:

* lockout    - repeated rejected biometric attempts temporarily block further biometric attempts for the account
* PIN        - an optional second factor, required when the risk layer says so
* risk layer - a small, explainable rule set. A PROTOTYPE of risk-based authorization, not fraud detection.
* limits     - per-transaction and daily simulated limits, read from settings
* events     - an audit trail of account actions (metadata only; never images, vectors, PINs or tokens)

Every rule here is enforced by the backend. The UI only displays what the backend decided.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.models import AuthenticationLog, PaymentSession, SecurityEvent, Transaction, User

# Rejections that say "this face / movement was not accepted". Camera or system problems (no face, blur, model
# unavailable, expired challenge ...) are not counted, so they never lock a customer out.
COUNTED_REASONS = frozenset({"LIVENESS_FAILED", "IDENTITY_MISMATCH", "LOW_CONFIDENCE", "DISTANCE_TOO_HIGH", "MULTIPLE_FACES_DETECTED"})

# Plain categories for the audit trail: they say what kind of check failed, never anything about whose face it was.
REASON_CATEGORY = {
    "LIVENESS_FAILED": "Liveness check",
    "IDENTITY_MISMATCH": "Face not recognised",
    "LOW_CONFIDENCE": "Face not recognised",
    "DISTANCE_TOO_HIGH": "Face not recognised",
    "MULTIPLE_FACES_DETECTED": "Camera view",
    "FACE_NOT_DETECTED": "Camera view",
    "FACE_TOO_SMALL": "Camera view",
    "POOR_IMAGE_QUALITY": "Camera view",
    "INVALID_IMAGE": "Camera view",
    "CHALLENGE_INVALID": "Session",
    "CHALLENGE_EXPIRED": "Session",
    "ACCOUNT_DISABLED": "Account",
    "NOT_ENROLLED": "Enrolment",
    "MODEL_UNAVAILABLE": "System",
    "INTERNAL_ERROR": "System",
}

LOCKED_MESSAGE = "Too many unsuccessful attempts. Please try again later or use another verification method."

PIN_LENGTH = 6


def now() -> datetime:
    return datetime.now(UTC)


def err(status: int, code: str, message: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message}, headers=headers)


def record_event(db: Session, user: User | None, kind: str, session_ref: str | None = None) -> None:
    """Adds an audit row to the caller's transaction (the caller commits)."""
    db.add(SecurityEvent(user_id=user.id if user else None, kind=kind, session_ref=session_ref))


# ------------------------------------------------------------------ biometric switch and lockout


def require_biometric_enabled(user: User) -> None:
    if not user.biometric_payments_enabled:
        raise err(403, "BIOMETRIC_DISABLED", "Face payments are turned off for your account. Turn them on in Security to use FacePay.")


def counted_failures(db: Session, user_id: int, since: datetime) -> list[datetime]:
    """Timestamps (newest first) of rejected biometric attempts that count against the account."""
    return list(
        db.scalars(
            select(AuthenticationLog.timestamp)
            .where(
                AuthenticationLog.user_id == user_id,
                AuthenticationLog.result == "FAILED",
                AuthenticationLog.failure_reason.in_(COUNTED_REASONS),
                AuthenticationLog.timestamp >= since,
            )
            .order_by(AuthenticationLog.timestamp.desc())
        )
    )


def biometric_lock_remaining(db: Session, user: User) -> int:
    """Seconds until biometric attempts are allowed again (0 = not locked). Derived from the audit log, so it needs no
    extra state and survives restarts."""
    s = get_settings()
    window = timedelta(minutes=s.biometric_lockout_window_minutes)
    times = counted_failures(db, user.id, now() - window)
    if len(times) < s.biometric_lockout_failures:
        return 0
    # Locked until enough of the failures leave the window for the count to drop below the limit.
    unlock_at = times[s.biometric_lockout_failures - 1] + window
    return max(1, int((unlock_at - now()).total_seconds()) + 1)


def require_biometric_allowed(db: Session, user: User) -> None:
    """Gate for every biometric attempt (payment authentication and the standalone face check)."""
    require_biometric_enabled(user)
    remaining = biometric_lock_remaining(db, user)
    if remaining:
        raise err(429, "BIOMETRIC_LOCKED", LOCKED_MESSAGE, {"Retry-After": str(remaining)})


# ------------------------------------------------------------------ payment PIN


def _valid_pin_format(pin: str) -> bool:
    return len(pin) == PIN_LENGTH and pin.isascii() and pin.isdigit()


def set_pin(db: Session, user: User, password: str, new_pin: str) -> None:
    if not verify_password(password, user.password_hash):
        raise err(403, "PASSWORD_INCORRECT", "That password is not correct.")
    if not _valid_pin_format(new_pin):
        raise err(422, "PIN_INVALID", f"The payment PIN must be exactly {PIN_LENGTH} digits.")
    first_time = user.payment_pin_hash is None
    user.payment_pin_hash = hash_password(new_pin)
    user.pin_changed_at = now()
    user.pin_failed_attempts, user.pin_locked_until = 0, None
    record_event(db, user, "PIN_SET" if first_time else "PIN_CHANGED")
    db.commit()


def remove_pin(db: Session, user: User, password: str) -> None:
    if not verify_password(password, user.password_hash):
        raise err(403, "PASSWORD_INCORRECT", "That password is not correct.")
    user.payment_pin_hash, user.pin_changed_at = None, None
    user.pin_failed_attempts, user.pin_locked_until = 0, None
    record_event(db, user, "PIN_REMOVED")
    db.commit()


def pin_lock_remaining(user: User) -> int:
    if user.pin_locked_until is None or user.pin_locked_until <= now():
        return 0
    return max(1, int((user.pin_locked_until - now()).total_seconds()) + 1)


def verify_pin(db: Session, user: User, pin: str | None, session_ref: str) -> None:
    """Checks the PIN for a step-up confirmation or raises. Wrong attempts are counted and lock the PIN for a while.
    The failure is committed here (the caller must not roll it back) so that guessing cannot be retried for free."""
    s = get_settings()
    if user.payment_pin_hash is None:
        raise err(403, "PIN_NOT_SET", "This payment needs your payment PIN. Set one in Security, then authenticate again.")
    remaining = pin_lock_remaining(user)
    if remaining:
        raise err(429, "PIN_LOCKED", "Too many incorrect PIN attempts. Please try again later.", {"Retry-After": str(remaining)})
    if pin is None:
        raise err(403, "PIN_REQUIRED", "This payment needs your payment PIN. Enter it to confirm.")  # not a guess: not counted
    if not _valid_pin_format(pin) or not verify_password(pin, user.payment_pin_hash):
        user.pin_failed_attempts += 1
        record_event(db, user, "PIN_FAILED", session_ref)
        if user.pin_failed_attempts >= s.pin_max_attempts:
            user.pin_locked_until = now() + timedelta(minutes=s.pin_lockout_minutes)
            user.pin_failed_attempts = 0
            record_event(db, user, "PIN_LOCKED", session_ref)
        db.commit()
        raise err(403, "PIN_INCORRECT", "That payment PIN is not correct.")
    user.pin_failed_attempts = 0
    db.flush()


# ------------------------------------------------------------------ risk-based step-up (prototype)


@dataclass(frozen=True)
class Risk:
    higher: bool
    reasons: tuple[str, ...]


RISK_LABELS = {
    "LARGE_AMOUNT": "a larger amount than usual",
    "RECENT_FACE_FAILURES": "recent unsuccessful face checks",
    "RAPID_ATTEMPTS": "many attempts in a short time",
    "RECENT_PIN_CHANGE": "a recently changed payment PIN",
}


def assess_risk(db: Session, user: User, ps: PaymentSession) -> Risk:
    """Explainable rules, nothing more. LOW = face + basic liveness check + confirmation.
    HIGHER = the same plus the payment PIN. Not fraud detection: it knows nothing about devices, locations or
    behaviour, and an attacker who can pass the face check can still pay any LOW-risk amount."""
    s = get_settings()
    t = now()
    reasons: list[str] = []
    if ps.amount >= s.step_up_amount_threshold:
        reasons.append("LARGE_AMOUNT")
    if len(counted_failures(db, user.id, t - timedelta(minutes=s.step_up_failure_window_minutes))) >= s.step_up_failure_count:
        reasons.append("RECENT_FACE_FAILURES")
    recent = db.scalar(
        select(func.count()).select_from(AuthenticationLog).where(AuthenticationLog.user_id == user.id, AuthenticationLog.timestamp >= t - timedelta(minutes=2))
    )
    if (recent or 0) >= s.step_up_rapid_attempts:
        reasons.append("RAPID_ATTEMPTS")
    if user.pin_changed_at is not None and user.pin_changed_at >= t - timedelta(minutes=s.step_up_pin_change_minutes):
        reasons.append("RECENT_PIN_CHANGE")
    return Risk(bool(reasons), tuple(reasons))


# ------------------------------------------------------------------ limits


def spent_last_24h(db: Session, user: User) -> Decimal:
    return db.scalar(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.payer_id == user.id, Transaction.status == "SUCCESS", Transaction.timestamp >= now() - timedelta(hours=24)
        )
    )


def check_amount_limits(db: Session, user: User, amount: Decimal, session_ref: str | None = None) -> None:
    """Backend-enforced simulated limits. Raises with a plain message; the UI never decides this."""
    s = get_settings()
    if amount > s.per_transaction_limit:
        raise err(409, "PER_TRANSACTION_LIMIT", f"This payment is above the simulated limit of ₹{s.per_transaction_limit:,.0f} per payment.")
    if spent_last_24h(db, user) + amount > s.daily_payment_limit:
        record_event(db, user, "DAILY_LIMIT_HIT", session_ref)
        db.commit()
        raise err(409, "DAILY_LIMIT_EXCEEDED", f"This payment would go over the simulated daily limit of ₹{s.daily_payment_limit:,.0f}.")


# ------------------------------------------------------------------ overview for the Security page


def overview(db: Session, user: User) -> dict:
    from app.services.face_service import active_profile, enrollment_status  # local import: face_service imports this module

    s = get_settings()
    last_ok = db.scalar(
        select(func.max(AuthenticationLog.timestamp)).where(AuthenticationLog.user_id == user.id, AuthenticationLog.result == "SUCCESS")
    )
    attempts = list(
        db.scalars(select(AuthenticationLog).where(AuthenticationLog.user_id == user.id).order_by(AuthenticationLog.id.desc()).limit(10))
    )
    txns = db.execute(
        select(Transaction.transaction_id, Transaction.amount, Transaction.timestamp, Transaction.merchant_id, Transaction.recipient_id)
        .where(Transaction.payer_id == user.id)
        .order_by(Transaction.id.desc())
        .limit(5)
    ).all()
    from app.models import Merchant

    names = {m.id: m.business_name for m in db.scalars(select(Merchant).where(Merchant.id.in_({t.merchant_id for t in txns if t.merchant_id})))} if txns else {}
    people = {u.id: u.name for u in db.scalars(select(User).where(User.id.in_({t.recipient_id for t in txns if t.recipient_id})))} if txns else {}
    events = list(db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == user.id).order_by(SecurityEvent.id.desc()).limit(10)))
    enrolment = enrollment_status(db, user)
    return {
        "biometric_enabled": user.biometric_payments_enabled,
        "face_enrolled": active_profile(db, user.id) is not None,
        "samples_stored": enrolment["total_samples"],
        "last_successful_authentication": last_ok,
        "biometric_locked_seconds": biometric_lock_remaining(db, user),
        "pin_set": user.payment_pin_hash is not None,
        "pin_locked_seconds": pin_lock_remaining(user),
        "recent_attempts": [
            {
                "timestamp": a.timestamp,
                "result": a.result,
                "category": REASON_CATEGORY.get(a.failure_reason, "Other") if a.result == "FAILED" else None,
                "payment_session_ref": a.payment_session_ref,
                "transaction_ref": a.transaction_ref,
            }
            for a in attempts
        ],
        "recent_transactions": [
            {
                "transaction_id": t.transaction_id,
                "merchant_name": names.get(t.merchant_id) or (f"To {people[t.recipient_id]}" if t.recipient_id in people else ""),
                "amount": t.amount,
                "timestamp": t.timestamp,
            }
            for t in txns
        ],
        "recent_events": [{"kind": e.kind, "timestamp": e.created_at, "session_ref": e.session_ref} for e in events],
        "limits": {
            "currency": "INR",
            "per_transaction": s.per_transaction_limit,
            "daily": s.daily_payment_limit,
            "spent_last_24h": spent_last_24h(db, user),
            "step_up_amount": s.step_up_amount_threshold,
            "authorization_seconds": s.payment_authorization_ttl_seconds,
        },
        "risk_label": "Risk-based authorization prototype",
    }
