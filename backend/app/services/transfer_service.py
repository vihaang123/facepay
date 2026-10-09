"""Customer-to-customer payments, step 1: preparing the payment.

Preparing creates a TRANSFER payment session that only the payer can see and use. From there it is exactly the
payment flow already in place: checkout view -> face verification and basic liveness check -> single-use
authorization -> explicit confirmation -> ledger posting. Nothing here moves money.
"""

import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import PaymentRequest, PaymentSession, User
from app.services import facepay_service, ledger_service, request_service
from app.services import payment_service as pay
from app.services import security_service as sec


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def _same_intent(ps: PaymentSession, payee: User, amount: Decimal, note: str | None, request_pk: int | None) -> bool:
    return ps.payee_user_id == payee.id and ps.amount == amount and (ps.description or None) == (note or None) and ps.payment_request_id == request_pk


def create_intent(
    db: Session,
    payer: User,
    *,
    recipient_facepay_id: str | None = None,
    amount: Decimal | None = None,
    note: str | None = None,
    idempotency_key: str | None = None,
    request: PaymentRequest | None = None,
) -> dict:
    """Validates everything on the server and returns the checkout view of the new (or, for a repeated idempotency
    key, the already existing) payment. The recipient and, for a money request, the amount come from the database;
    nothing the client sends about them is trusted beyond the lookup key."""
    s = get_settings()
    sec.require_biometric_enabled(payer)

    if request is not None:
        payee = db.get(User, request.requester_id)
        amount, note = request.amount, request.note
        if payee is None or payee.status != "active":
            raise _err(409, "RECIPIENT_UNAVAILABLE", "The person who asked for this money cannot receive payments right now.")
    else:
        payee = facepay_service.find_active(db, recipient_facepay_id or "")
        if payee is None:
            raise _err(404, "RECIPIENT_NOT_FOUND", "No FacePay account matches that ID. Check it and try again.")
    if payee.id == payer.id:
        raise _err(422, "SELF_TRANSFER", "You cannot send money to yourself.")
    assert amount is not None

    request_pk = request.id if request is not None else None
    if idempotency_key:
        prior = db.scalar(select(PaymentSession).where(PaymentSession.payer_user_id == payer.id, PaymentSession.idempotency_key == idempotency_key))
        if prior is not None:
            if not _same_intent(prior, payee, amount, note, request_pk):
                raise _err(409, "IDEMPOTENCY_CONFLICT", "That request key was already used for a different payment.")
            return pay.checkout_view(db, payer, prior.session_id)

    if request_pk is not None:  # one live payment per request: reopen it instead of making a second
        open_ps = db.scalar(
            select(PaymentSession).where(PaymentSession.payment_request_id == request_pk, PaymentSession.status.in_(pay.PAYABLE), PaymentSession.payer_user_id == payer.id)
        )
        if open_ps is not None:
            pay._sweep(db, session_pk=open_ps.id)
            db.commit()
            db.refresh(open_ps)
            if open_ps.status in pay.PAYABLE:
                return pay.checkout_view(db, payer, open_ps.session_id)

    sec.check_amount_limits(db, payer, amount)  # per-payment and 24-hour limits (backend-enforced)
    if payer.balance < amount:
        raise ledger_service.insufficient(payer.balance)

    expires = datetime.now(UTC) + timedelta(minutes=s.transfer_session_minutes)
    if request is not None:
        expires = min(expires, request.expires_at)
    ps = PaymentSession(
        session_id="ps_" + secrets.token_urlsafe(16),
        kind="TRANSFER",
        merchant_id=None,
        payer_user_id=payer.id,
        payee_user_id=payee.id,
        payment_request_id=request_pk,
        idempotency_key=idempotency_key or None,
        amount=amount,
        currency="INR",
        description=note or None,
        status="CREATED",
        expires_at=expires,
    )
    db.add(ps)
    try:
        db.commit()
    except IntegrityError:  # a concurrent identical call won (same idempotency key, or the same request): reuse its result
        db.rollback()
        winner = None
        if idempotency_key:
            winner = db.scalar(select(PaymentSession).where(PaymentSession.payer_user_id == payer.id, PaymentSession.idempotency_key == idempotency_key))
        if winner is None and request_pk is not None:
            winner = db.scalar(select(PaymentSession).where(PaymentSession.payment_request_id == request_pk, PaymentSession.status.in_(pay.PAYABLE)))
        if winner is None or winner.payer_user_id != payer.id:
            raise _err(409, "TRANSFER_CONFLICT", "That payment is already in progress.") from None
        return pay.checkout_view(db, payer, winner.session_id)
    return pay.checkout_view(db, payer, ps.session_id)


def pay_request(db: Session, payer: User, ref: str, idempotency_key: str | None = None) -> dict:
    """The asked customer starts paying a request. Only the designated payer, only while it is PENDING."""
    request_service.expire_overdue(db)
    req = db.scalar(select(PaymentRequest).where(PaymentRequest.request_id == ref, PaymentRequest.payer_id == payer.id))
    if req is None:
        raise request_service._not_found()
    if req.status != "PENDING":
        raise _err(409, "REQUEST_NOT_PENDING", request_service._NOT_PENDING.get(req.status, "This request can no longer be paid."))
    return create_intent(db, payer, request=req, idempotency_key=idempotency_key)


def cancel_intent(db: Session, payer: User, session_id: str) -> dict:
    """The payer backs out before confirming. Voids any live authorization. Only the payer's own TRANSFER payment."""
    owned = db.scalar(select(PaymentSession.id).where(PaymentSession.session_id == session_id, PaymentSession.kind == "TRANSFER", PaymentSession.payer_user_id == payer.id))
    if owned is None:
        raise _err(404, "SESSION_NOT_FOUND", "Payment session not found.")
    ps = pay._locked_session(db, session_id)
    if ps.status not in pay.PAYABLE:
        pay._reject(db, 409, "SESSION_NOT_CANCELLABLE", f"A payment that is {ps.status} cannot be cancelled.")
    ps.status = "CANCELLED"
    pay._sweep(db, session_pk=ps.id)
    db.commit()
    return {"session_id": session_id, "status": "CANCELLED"}
