"""Simulated FacePay payments. The database is authoritative; nothing here trusts the client for identity,
authentication, amount, merchant, session ownership or status.

Two kinds of payment session share this flow: a MERCHANT bill (below) and a customer-to-customer TRANSFER prepared by
transfer_service for exactly one payer and one recipient. After preparation they are handled identically.

Flow: merchant creates a session -> customer opens checkout -> customer passes face authentication FOR THAT
session (the Phase 4 decision, unchanged) -> the backend issues a short-lived single-use authorization bound to
(customer, session) -> the customer confirms -> the backend consumes the authorization and writes the
transaction in one database transaction. No real money, UPI or bank is involved.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.ml import registry
from app.ml.preprocessing import FaceDetector
from app.core import facepay_id as fid
from app.models import AuthenticationLog, Merchant, PaymentAuthorization, PaymentRequest, PaymentSession, Transaction, User
from app.services import face_auth_service, ledger_service, request_service
from app.services import security_service as sec
from app.services.security_service import COUNTED_REASONS  # rejections that count against the session (and the account)

PAYABLE = ("CREATED", "AUTHENTICATED")
_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # no I, L, O, U


# ------------------------------------------------------------------ helpers


def _now() -> datetime:
    return datetime.now(UTC)


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_transaction_id() -> str:
    """FP-XXXXXXXXXX: random, unique, and not modelled on any real payment network's ID format."""
    return "FP-" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(10))


def _reject(db: Session, status_code: int, code: str, message: str):
    db.commit()  # persist any time-based transitions applied by _sweep before refusing
    raise _err(status_code, code, message)


_NOT_PAYABLE = {
    "PAID": (409, "SESSION_ALREADY_PAID", "This payment has already been completed."),
    "EXPIRED": (409, "SESSION_EXPIRED", "This payment session has expired."),
    "CANCELLED": (409, "SESSION_CANCELLED", "This payment session was cancelled by the merchant."),
    "FAILED": (409, "SESSION_FAILED", "Too many failed face authentication attempts. Ask the merchant for a new payment session."),
}


def _require_payable(db: Session, ps: PaymentSession) -> None:
    if ps.status not in PAYABLE:
        _reject(db, *_NOT_PAYABLE[ps.status])


def _sweep(db: Session, *, merchant_id: int | None = None, session_pk: int | None = None) -> None:
    """Apply time-based transitions in the database (not committed here):
    overdue authorizations -> EXPIRED, overdue open sessions -> EXPIRED, AUTHENTICATED sessions that no longer
    have a live authorization -> CREATED, authorizations of finished sessions -> REVOKED."""
    db.flush()  # the session factory has autoflush off: pending status changes must reach the bulk UPDATEs below
    now = _now()
    scope = []
    if merchant_id is not None:
        scope.append(PaymentSession.merchant_id == merchant_id)
    if session_pk is not None:
        scope.append(PaymentSession.id == session_pk)

    in_scope = select(PaymentSession.id).where(*scope) if scope else None
    auth_scope = [PaymentAuthorization.payment_session_id.in_(in_scope)] if in_scope is not None else []

    db.execute(
        update(PaymentAuthorization)
        .where(PaymentAuthorization.status == "ACTIVE", PaymentAuthorization.expires_at <= now, *auth_scope)
        .values(status="EXPIRED")
    )
    db.execute(
        update(PaymentSession)
        .where(PaymentSession.status.in_(PAYABLE), PaymentSession.expires_at <= now, *scope)
        .values(status="EXPIRED")
    )
    live = exists().where(
        PaymentAuthorization.payment_session_id == PaymentSession.id,
        PaymentAuthorization.status == "ACTIVE",
        PaymentAuthorization.expires_at > now,
    )
    db.execute(update(PaymentSession).where(PaymentSession.status == "AUTHENTICATED", ~live, *scope).values(status="CREATED"))
    finished = select(PaymentSession.id).where(PaymentSession.status.in_(("EXPIRED", "CANCELLED", "FAILED")), *scope)
    db.execute(
        update(PaymentAuthorization)
        .where(PaymentAuthorization.status == "ACTIVE", PaymentAuthorization.payment_session_id.in_(finished))
        .values(status="REVOKED")
    )


def _locked_session(db: Session, session_id: str) -> PaymentSession:
    """Row-locked session with time transitions applied. 404 if unknown."""
    pk = db.scalar(select(PaymentSession.id).where(PaymentSession.session_id == session_id))
    if pk is None:
        raise _err(404, "SESSION_NOT_FOUND", "Payment session not found.")
    _sweep(db, session_pk=pk)
    ps = db.scalar(select(PaymentSession).where(PaymentSession.id == pk).with_for_update().execution_options(populate_existing=True))
    return ps


def _check_participant(db: Session, ps: PaymentSession, user: User) -> None:
    """A customer-to-customer payment belongs to its payer alone: for anyone else it does not exist."""
    if ps.payer_user_id is not None and ps.payer_user_id != user.id:
        db.commit()
        raise _err(404, "SESSION_NOT_FOUND", "Payment session not found.")


def max_auth_failures() -> int:
    return get_settings().max_auth_failures_per_session


def _attempts_remaining(ps: PaymentSession) -> int:
    return max(0, max_auth_failures() - ps.failed_auth_attempts)


# ------------------------------------------------------------------ merchant side


def create_session(db: Session, merchant: Merchant, *, amount: Decimal, order_reference: str, description: str | None, expires_in_minutes: int) -> PaymentSession:
    limit = get_settings().per_transaction_limit
    if amount > limit:
        raise _err(422, "PER_TRANSACTION_LIMIT", f"The simulated limit is ₹{limit:,.0f} per payment.")
    ps = PaymentSession(
        session_id="ps_" + secrets.token_urlsafe(16),
        merchant_id=merchant.id,
        amount=amount,
        currency="INR",
        order_reference=order_reference,
        description=description or None,
        status="CREATED",
        expires_at=_now() + timedelta(minutes=expires_in_minutes),
    )
    db.add(ps)
    db.commit()
    db.refresh(ps)
    return ps


def _session_out(ps: PaymentSession, transaction_id: str | None = None) -> dict:
    return {
        "session_id": ps.session_id,
        "amount": ps.amount,
        "currency": ps.currency,
        "order_reference": ps.order_reference,
        "description": ps.description,
        "status": ps.status,
        "created_at": ps.created_at,
        "expires_at": ps.expires_at,
        "checkout_path": f"/checkout/{ps.session_id}",
        "transaction_id": transaction_id,
    }


def _paid_transaction_ids(db: Session, pks: list[int]) -> dict[int, str]:
    if not pks:
        return {}
    rows = db.execute(
        select(Transaction.payment_session_id, Transaction.transaction_id).where(
            Transaction.payment_session_id.in_(pks), Transaction.status == "SUCCESS"
        )
    )
    return {pk: tid for pk, tid in rows}


def merchant_sessions(db: Session, merchant: Merchant, *, limit: int, offset: int, status: str | None) -> list[dict]:
    _sweep(db, merchant_id=merchant.id)
    db.commit()
    q = select(PaymentSession).where(PaymentSession.merchant_id == merchant.id)
    if status:
        q = q.where(PaymentSession.status == status)
    rows = list(db.scalars(q.order_by(PaymentSession.id.desc()).limit(limit).offset(offset)))
    paid = _paid_transaction_ids(db, [r.id for r in rows])
    return [_session_out(r, paid.get(r.id)) for r in rows]


def merchant_session(db: Session, merchant: Merchant, session_id: str) -> dict:
    # Another merchant's session is indistinguishable from a missing one.
    ps = db.scalar(select(PaymentSession).where(PaymentSession.session_id == session_id, PaymentSession.merchant_id == merchant.id))
    if ps is None:
        raise _err(404, "SESSION_NOT_FOUND", "Payment session not found.")
    _sweep(db, session_pk=ps.id)
    db.commit()
    db.refresh(ps)
    return _session_out(ps, _paid_transaction_ids(db, [ps.id]).get(ps.id))


def cancel_session(db: Session, merchant: Merchant, session_id: str) -> dict:
    owned = db.scalar(select(PaymentSession.id).where(PaymentSession.session_id == session_id, PaymentSession.merchant_id == merchant.id))
    if owned is None:
        raise _err(404, "SESSION_NOT_FOUND", "Payment session not found.")
    ps = _locked_session(db, session_id)
    if ps.status not in PAYABLE:
        _reject(db, 409, "SESSION_NOT_CANCELLABLE", f"A session that is {ps.status} cannot be cancelled.")
    ps.status = "CANCELLED"
    _sweep(db, session_pk=ps.id)  # revokes any live authorization
    db.commit()
    db.refresh(ps)
    return _session_out(ps)


# ------------------------------------------------------------------ customer checkout


def checkout_view(db: Session, user: User, session_id: str) -> dict:
    ps0 = db.scalar(select(PaymentSession).where(PaymentSession.session_id == session_id))
    if ps0 is None or (ps0.payer_user_id is not None and ps0.payer_user_id != user.id):
        raise _err(404, "SESSION_NOT_FOUND", "Payment session not found.")
    _sweep(db, session_pk=ps0.id)
    db.commit()
    ps = db.scalar(select(PaymentSession).where(PaymentSession.id == ps0.id).execution_options(populate_existing=True))
    merchant = db.get(Merchant, ps.merchant_id) if ps.merchant_id else None
    payee = db.get(User, ps.payee_user_id) if ps.payee_user_id else None
    request_ref = db.scalar(select(PaymentRequest.request_id).where(PaymentRequest.id == ps.payment_request_id)) if ps.payment_request_id else None
    return {
        "session_id": ps.session_id,
        "kind": ps.kind,
        "merchant_name": merchant.business_name if merchant else None,
        "recipient_name": payee.name if payee else None,
        "recipient_facepay_id": payee.facepay_id if payee else None,
        "recipient_masked_id": fid.mask(payee.facepay_id) if payee else None,
        "note": ps.description if ps.kind == "TRANSFER" else None,
        "request_id": request_ref,
        "order_reference": ps.order_reference,
        "description": ps.description if ps.kind == "MERCHANT" else None,
        "amount": ps.amount,
        "currency": ps.currency,
        "status": ps.status,
        "expires_at": ps.expires_at,
        "max_auth_attempts": max_auth_failures(),
        "authorization_seconds": get_settings().payment_authorization_ttl_seconds,
        "attempts_remaining": _attempts_remaining(ps),
        "balance": user.balance,  # the payer's own simulated balance, shown on the review screen
    }


def start_authentication(db: Session, user: User, session_id: str) -> dict:
    sec.require_biometric_allowed(db, user)  # switched off, or too many rejected attempts: before any camera work
    ps = _locked_session(db, session_id)
    _check_participant(db, ps, user)
    _require_payable(db, ps)
    sec.check_amount_limits(db, user, ps.amount, ps.session_id)
    db.commit()
    return face_auth_service.issue_challenge(db, user)


def authenticate_for_payment(db: Session, user: User, session_id: str, challenge_id: str, frames: list[str], detector: FaceDetector) -> dict:
    sec.require_biometric_allowed(db, user)
    ps = _locked_session(db, session_id)
    _check_participant(db, ps, user)
    _require_payable(db, ps)
    sec.check_amount_limits(db, user, ps.amount, ps.session_id)
    pk = ps.id
    db.commit()  # release the row lock: the ML work below can take a while

    result = face_auth_service.authenticate(db, user, challenge_id, frames, detector)
    log = db.get(AuthenticationLog, result["authentication_id"])
    log.payment_session_ref = session_id  # audit reference only; nothing biometric
    db.commit()

    ps = _locked_session(db, session_id)
    authorization = None
    if result["result"] == "AUTHENTICATED":
        if ps.status not in PAYABLE:  # cancelled / expired while the camera was running
            _reject(db, *_NOT_PAYABLE[ps.status])
        ttl = get_settings().payment_authorization_ttl_seconds
        raw = secrets.token_urlsafe(32)
        expires_at = _now() + timedelta(seconds=ttl)
        risk = sec.assess_risk(db, user, ps)
        db.execute(  # at most one live authorization per (session, customer)
            update(PaymentAuthorization)
            .where(PaymentAuthorization.payment_session_id == pk, PaymentAuthorization.user_id == user.id, PaymentAuthorization.status == "ACTIVE")
            .values(status="REVOKED")
        )
        db.add(
            PaymentAuthorization(
                token_hash=_hash(raw),
                payment_session_id=pk,
                user_id=user.id,
                authentication_log_id=result["authentication_id"],
                expires_at=expires_at,
                # Snapshot of exactly what this authorization is for. Confirmation re-checks every field.
                merchant_id=ps.merchant_id,
                payee_user_id=ps.payee_user_id,
                amount=ps.amount,
                currency=ps.currency,
                order_reference=ps.order_reference,
                model_version=result["model_version"],
                step_up_required=risk.higher,
                step_up_reasons=",".join(risk.reasons) or None,
            )
        )
        ps.status = "AUTHENTICATED"
        authorization = {
            "authorization_token": raw,
            "expires_in_seconds": ttl,
            "expires_at": expires_at,
            "step_up_required": risk.higher,
            "step_up_reasons": [sec.RISK_LABELS[r] for r in risk.reasons],
            "pin_set": user.payment_pin_hash is not None,
        }
    elif result["reason"] in COUNTED_REASONS and ps.status in PAYABLE:
        ps.failed_auth_attempts += 1
        if ps.failed_auth_attempts >= max_auth_failures():
            ps.status = "FAILED"
            _sweep(db, session_pk=pk)
    db.commit()
    db.refresh(ps)
    return {**result, "session_status": ps.status, "attempts_remaining": _attempts_remaining(ps), "authorization": authorization}


# ------------------------------------------------------------------ confirmation


def _authentication_label(db: Session, ps: PaymentSession | None) -> str:
    """How the payer was verified, for the receipt. Derived from the consumed authorization, not from the client."""
    if ps is None:
        return "Face + basic liveness check"
    auth = db.scalar(
        select(PaymentAuthorization).where(PaymentAuthorization.payment_session_id == ps.id, PaymentAuthorization.status == "CONSUMED")
    )
    if auth is not None and auth.step_up_verified_at is not None:
        return "Face + basic liveness check + payment PIN"
    return "Face + basic liveness check"


def _receipt(db: Session, txn: Transaction) -> dict:
    ps = db.get(PaymentSession, txn.payment_session_id) if txn.payment_session_id else None
    payer = db.get(User, txn.payer_id)
    recipient = db.get(User, txn.recipient_id) if txn.recipient_id else None
    merchant = db.get(Merchant, txn.merchant_id) if txn.merchant_id else None
    request_ref = db.scalar(select(PaymentRequest.request_id).where(PaymentRequest.transaction_id == txn.id))
    return {
        "transaction_id": txn.transaction_id,
        "kind": txn.kind,
        "status": txn.status,
        "amount": txn.amount,
        "currency": txn.currency,
        "payment_method": txn.payment_method,
        "timestamp": txn.timestamp,
        "payer_name": payer.name,
        "payer_masked_id": fid.mask(payer.facepay_id),
        "merchant_name": merchant.business_name if merchant else None,
        "recipient_name": recipient.name if recipient else None,
        "recipient_masked_id": fid.mask(recipient.facepay_id) if recipient else None,
        "order_reference": ps.order_reference if ps else None,
        "description": ps.description if ps and txn.kind == "MERCHANT_PAYMENT" else None,
        "note": txn.note,
        "request_id": request_ref,
        "session_id": ps.session_id if ps else None,
        "authentication": _authentication_label(db, ps),
    }


def confirm_payment(
    db: Session,
    user: User,
    session_id: str,
    token: str,
    *,
    expected_amount: Decimal,
    expected_merchant: str | None = None,
    expected_order_reference: str | None = None,
    expected_recipient: str | None = None,
    pin: str | None = None,
) -> dict:
    """The explicit customer confirmation. Face recognition alone never gets here: the caller must hold a live,
    single-use authorization issued for exactly this customer and payment (session, payee, amount, currency, order,
    model version), and must state what they were shown - the amount and, for a merchant bill, the merchant and order,
    or, for a transfer, the recipient's FacePay ID. Higher-risk payments also need the payment PIN. On success the
    transaction row, the debit and the credit are one database commit."""
    sec.require_biometric_enabled(user)  # switched off after authenticating: the ticket is no longer honoured
    ps = _locked_session(db, session_id)  # row lock: two confirmations of one session are serialized
    _check_participant(db, ps, user)
    _require_payable(db, ps)
    merchant = db.get(Merchant, ps.merchant_id) if ps.merchant_id else None
    payee = db.get(User, ps.payee_user_id) if ps.payee_user_id else None

    if expected_amount != ps.amount:
        _reject(db, 409, "AMOUNT_MISMATCH", "The amount shown does not match this payment session. Reload the checkout.")
    if ps.kind == "MERCHANT":
        if expected_merchant is None or expected_order_reference is None:
            _reject(db, 422, "EXPECTATION_MISSING", "Confirm the merchant and order you were shown.")
        if expected_merchant.strip() != merchant.business_name:
            _reject(db, 409, "MERCHANT_MISMATCH", "The merchant shown does not match this payment session. Reload the checkout.")
        if expected_order_reference.strip() != (ps.order_reference or ""):
            _reject(db, 409, "ORDER_MISMATCH", "The order shown does not match this payment session. Reload the checkout.")
    else:
        if expected_recipient is None:
            _reject(db, 422, "EXPECTATION_MISSING", "Confirm the recipient you were shown.")
        try:
            shown = fid.normalize(expected_recipient)
        except fid.InvalidFacePayId:
            shown = None
        if payee is None or shown != payee.facepay_id:
            _reject(db, 409, "RECIPIENT_MISMATCH", "The recipient shown does not match this payment. Reload and review it again.")

    auth = db.scalar(select(PaymentAuthorization).where(PaymentAuthorization.token_hash == _hash(token)).with_for_update())
    invalid = _err(403, "AUTHORIZATION_INVALID", "Face authorization is not valid for this payment. Authenticate again.")
    # Unknown, someone else's and another session's tickets all look the same.
    if auth is None or auth.user_id != user.id or auth.payment_session_id != ps.id:
        db.commit()
        raise invalid
    if auth.status == "CONSUMED":
        _reject(db, 403, "AUTHORIZATION_USED", "This authorization was already used. Authenticate again.")
    if auth.status == "EXPIRED" or (auth.status == "ACTIVE" and auth.expires_at <= _now()):
        auth.status = "EXPIRED"
        _reject(db, 403, "AUTHORIZATION_EXPIRED", "The authorization expired. Authenticate again.")
    if auth.status != "ACTIVE":
        db.commit()
        raise invalid
    log = db.get(AuthenticationLog, auth.authentication_log_id) if auth.authentication_log_id else None
    if log is None or log.user_id != user.id or log.result != "SUCCESS":
        db.commit()
        raise invalid
    # The ticket must match the payment as it is now. A missing snapshot (an authorization issued before it existed)
    # or any difference makes the ticket worthless, and so does a model retrained since the face check.
    active = registry.active_model_row(db)
    snapshot_ok = (
        auth.merchant_id == ps.merchant_id
        and auth.payee_user_id == ps.payee_user_id
        and auth.amount is not None
        and auth.amount == ps.amount
        and auth.currency == ps.currency
        and auth.order_reference == ps.order_reference
        and auth.model_version is not None
        and active is not None
        and auth.model_version == active.version
    )
    if not snapshot_ok:
        auth.status = "REVOKED"
        db.commit()
        raise invalid

    if payee is not None and payee.status != "active":
        _reject(db, 409, "RECIPIENT_UNAVAILABLE", "The recipient cannot receive payments right now.")
    sec.check_amount_limits(db, user, ps.amount, ps.session_id)
    if user.balance < ps.amount:  # early, so nobody is asked for a PIN on a payment that cannot go through
        _reject(db, 409, "INSUFFICIENT_BALANCE", f"Not enough simulated balance. You have ₹{user.balance:,.2f}.")
    if auth.step_up_required:
        sec.verify_pin(db, user, pin, ps.session_id)  # raises (and commits the failure count) unless the PIN is right
        auth.step_up_verified_at = _now()

    request = None
    if ps.payment_request_id is not None:  # lock order everywhere: session, then request, then accounts
        request = request_service.lock(db, ps.payment_request_id)
        if request.status == "PENDING" and request.expires_at <= _now():  # ran out of time while the customer was verifying
            request_service.transition(request, "EXPIRED")
        if request.status != "PENDING":
            ps.status = "CANCELLED"
            auth.status = "REVOKED"
            message = request_service._NOT_PENDING.get(request.status, "This request can no longer be paid.")
            _reject(db, 409, "REQUEST_NOT_PENDING", message)

    now = _now()
    txn = Transaction(
        transaction_id=new_transaction_id(),
        kind="MERCHANT_PAYMENT" if ps.kind == "MERCHANT" else "TRANSFER",
        payer_id=user.id,
        merchant_id=ps.merchant_id,
        recipient_id=ps.payee_user_id,
        payment_session_id=ps.id,
        amount=ps.amount,  # authoritative: the session, never the request
        currency=ps.currency,
        note=ps.description if ps.kind == "TRANSFER" else None,
        payment_method="FACE_PAY",
        status="SUCCESS",
        timestamp=now,
    )
    db.add(txn)
    try:
        db.flush()
        ledger_service.post_payment(db, txn, payer_id=user.id, recipient_user_id=ps.payee_user_id, merchant_id=ps.merchant_id)
    except HTTPException:
        db.rollback()  # nothing was debited, nothing consumed: the customer can fix the cause and try again
        raise
    except IntegrityError:
        db.rollback()
        raise _err(409, "SESSION_ALREADY_PAID", "This payment has already been completed.") from None

    auth.status, auth.consumed_at = "CONSUMED", now
    ps.status = "PAID"
    if request is not None:
        request_service.transition(request, "PAID")
        request.transaction_id = txn.id
    log.transaction_ref = txn.transaction_id
    sec.record_event(db, user, "PAYMENT_CONFIRMED", ps.session_id)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _err(409, "SESSION_ALREADY_PAID", "This payment has already been completed.") from None
    db.refresh(txn)
    return _receipt(db, txn)


# ------------------------------------------------------------------ history and receipts


def _order_by(sort: str):
    """Stable orderings for transaction lists (ties broken by newest id)."""
    t = Transaction
    return {
        "newest": (t.id.desc(),),
        "oldest": (t.id.asc(),),
        "amount_desc": (t.amount.desc(), t.id.desc()),
        "amount_asc": (t.amount.asc(), t.id.desc()),
    }[sort]


def _like(column, text_: str):
    escaped = text_.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")  # user text is data, not a pattern
    return column.ilike(f"%{escaped}%", escape="\\")


def customer_transactions(db: Session, user: User, *, limit: int, offset: int, status: str | None = None, q: str | None = None, sort: str = "newest") -> list[dict]:
    query = (
        select(Transaction, Merchant.business_name, PaymentSession.order_reference, PaymentSession.currency)
        .join(Merchant, Merchant.id == Transaction.merchant_id)
        .outerjoin(PaymentSession, PaymentSession.id == Transaction.payment_session_id)
        .where(Transaction.payer_id == user.id)
    )
    if status:
        query = query.where(Transaction.status == status)
    if q:
        query = query.where(or_(_like(Transaction.transaction_id, q), _like(Merchant.business_name, q), _like(PaymentSession.order_reference, q)))
    rows = db.execute(query.order_by(*_order_by(sort)).limit(limit).offset(offset))
    return [
        {
            "transaction_id": t.transaction_id, "status": t.status, "amount": t.amount, "currency": cur or "INR",
            "payment_method": t.payment_method, "timestamp": t.timestamp, "merchant_name": biz, "order_reference": ref,
        }
        for t, biz, ref, cur in rows
    ]


def customer_summary(db: Session, user: User) -> dict:
    t = Transaction
    since = _now() - timedelta(days=30)
    spent, count, recent, last = db.execute(
        select(
            func.coalesce(func.sum(t.amount), 0),
            func.count(),
            func.coalesce(func.sum(t.amount).filter(t.timestamp >= since), 0),
            func.max(t.timestamp),
        ).where(t.payer_id == user.id, t.status == "SUCCESS")
    ).one()
    return {"currency": "INR", "total_spent": spent, "payments": count, "spent_last_30_days": recent, "last_payment_at": last}


def customer_receipt(db: Session, user: User, transaction_id: str) -> dict:
    txn = db.scalar(
        select(Transaction).where(Transaction.transaction_id == transaction_id, or_(Transaction.payer_id == user.id, Transaction.recipient_id == user.id))
    )
    if txn is None:
        raise _err(404, "TRANSACTION_NOT_FOUND", "Transaction not found.")
    return _receipt(db, txn)


def merchant_transactions(db: Session, merchant: Merchant, *, limit: int, offset: int, status: str | None = None, q: str | None = None, sort: str = "newest") -> list[dict]:
    query = (
        select(Transaction, User.name, PaymentSession.order_reference, PaymentSession.currency, PaymentSession.session_id)
        .join(User, User.id == Transaction.payer_id)
        .outerjoin(PaymentSession, PaymentSession.id == Transaction.payment_session_id)
        .where(Transaction.merchant_id == merchant.id)
    )
    if status:
        query = query.where(Transaction.status == status)
    if q:
        query = query.where(or_(_like(Transaction.transaction_id, q), _like(User.name, q), _like(PaymentSession.order_reference, q)))
    rows = db.execute(query.order_by(*_order_by(sort)).limit(limit).offset(offset))
    return [
        {
            "transaction_id": t.transaction_id, "status": t.status, "amount": t.amount, "currency": cur or "INR",
            "payment_method": t.payment_method, "timestamp": t.timestamp, "payer_name": name, "order_reference": ref, "session_id": sid,
        }
        for t, name, ref, cur, sid in rows
    ]


def merchant_receipt(db: Session, merchant: Merchant, transaction_id: str) -> dict:
    txn = db.scalar(select(Transaction).where(Transaction.transaction_id == transaction_id, Transaction.merchant_id == merchant.id))
    if txn is None:
        raise _err(404, "TRANSACTION_NOT_FOUND", "Transaction not found.")
    return _receipt(db, txn)


def merchant_summary(db: Session, merchant: Merchant, days: int = 14) -> dict:
    _sweep(db, merchant_id=merchant.id)
    db.commit()
    t = Transaction
    revenue, total, ok, bad_tx = db.execute(
        select(
            func.coalesce(func.sum(t.amount).filter(t.status == "SUCCESS"), 0),
            func.count(),
            func.count().filter(t.status == "SUCCESS"),
            func.count().filter(t.status == "FAILED"),
        ).where(t.merchant_id == merchant.id)
    ).one()
    by_status = dict(
        db.execute(
            select(PaymentSession.status, func.count()).where(PaymentSession.merchant_id == merchant.id).group_by(PaymentSession.status)
        ).all()
    )
    # Days are calendar days in India time, since the currency is INR.
    day = func.date(func.timezone("Asia/Kolkata", t.timestamp))
    today = db.scalar(select(func.date(func.timezone("Asia/Kolkata", func.now()))))
    start = today - timedelta(days=days - 1)
    rows = {
        d: (rev, n)
        for d, rev, n in db.execute(
            select(day, func.sum(t.amount), func.count())
            .where(t.merchant_id == merchant.id, t.status == "SUCCESS", day >= start)
            .group_by(day)
        )
    }
    series = []
    for i in range(days):
        d = start + timedelta(days=i)
        rev, n = rows.get(d, (Decimal("0"), 0))
        series.append({"date": d, "revenue": rev, "count": n})
    return {
        "currency": "INR",
        "total_revenue": revenue,
        "transactions": total,
        "successful_payments": ok,
        "failed_payments": bad_tx + by_status.get("FAILED", 0),
        "open_sessions": by_status.get("CREATED", 0) + by_status.get("AUTHENTICATED", 0),
        "expired_sessions": by_status.get("EXPIRED", 0),
        "cancelled_sessions": by_status.get("CANCELLED", 0),
        "revenue_by_day": series,
    }


def merchant_security_summary(db: Session, merchant: Merchant) -> dict:
    """Aggregate, merchant-scoped authentication outcomes: how this merchant's own sessions ended. No customer is
    named and no biometric score is exposed."""
    _sweep(db, merchant_id=merchant.id)
    db.commit()
    by_status = dict(db.execute(select(PaymentSession.status, func.count()).where(PaymentSession.merchant_id == merchant.id).group_by(PaymentSession.status)).all())
    verified = db.scalar(
        select(func.count(func.distinct(PaymentAuthorization.payment_session_id)))
        .join(PaymentSession, PaymentSession.id == PaymentAuthorization.payment_session_id)
        .where(PaymentSession.merchant_id == merchant.id)
    )
    stepped = db.scalar(
        select(func.count())
        .select_from(PaymentAuthorization)
        .join(PaymentSession, PaymentSession.id == PaymentAuthorization.payment_session_id)
        .where(PaymentSession.merchant_id == merchant.id, PaymentAuthorization.status == "CONSUMED", PaymentAuthorization.step_up_verified_at.is_not(None))
    )
    return {
        "sessions": sum(by_status.values()),
        "paid": by_status.get("PAID", 0),
        "closed_after_failed_face_checks": by_status.get("FAILED", 0),
        "cancelled": by_status.get("CANCELLED", 0),
        "expired": by_status.get("EXPIRED", 0),
        "face_verified_sessions": verified or 0,
        "paid_with_pin_step_up": stepped or 0,
        "note": "Customers are verified with a basic face and movement check, plus a confirmation step. FacePay is a simulation and gives no protection against advanced spoofing.",
    }
