"""Money requests between customers. A request is only a question: creating one moves no money and does not touch
the other customer's balance. The asked customer opens it, reviews it, and pays it through the same face
verification -> authorization -> explicit confirmation path as any other payment.

PENDING -> PAID | DECLINED | CANCELLED | EXPIRED, and every one of those is final. The transitions are enforced here,
on the server, with row locks, so two actions on one request (pay and cancel, say) cannot both win.
"""

import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.core import facepay_id as fid
from app.core.config import get_settings
from app.models import PaymentAuthorization, PaymentRequest, PaymentSession, Transaction, User
from app.services import facepay_service
from app.services import security_service as sec

PAYABLE_SESSION = ("CREATED", "AUTHENTICATED")
MAX_PENDING_PER_PAIR = 5
MAX_PENDING_OUTGOING = 25

# The whole state machine: only PENDING has exits.
TRANSITIONS = {"PENDING": {"PAID", "DECLINED", "CANCELLED", "EXPIRED"}}

_NOT_PENDING = {
    "PAID": "This request has already been paid.",
    "DECLINED": "This request was declined.",
    "CANCELLED": "This request was cancelled by the sender.",
    "EXPIRED": "This request has expired.",
}


def now() -> datetime:
    return datetime.now(UTC)


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def _not_found() -> HTTPException:
    # Someone else's request is indistinguishable from one that does not exist.
    return _err(404, "REQUEST_NOT_FOUND", "Payment request not found.")


def transition(req: PaymentRequest, new_status: str) -> None:
    """Applies a status change or raises 409. The single place where request states change."""
    if new_status not in TRANSITIONS.get(req.status, set()):
        raise _err(409, "REQUEST_NOT_PENDING", _NOT_PENDING.get(req.status, "This request can no longer be changed."))
    req.status = new_status
    req.resolved_at = now()


def _close_open_payments(db: Session, request_pk: int) -> None:
    """Cancels the unfinished payment of a request that just ended, and voids its authorization."""
    ids = select(PaymentSession.id).where(PaymentSession.payment_request_id == request_pk, PaymentSession.status.in_(PAYABLE_SESSION))
    db.execute(
        update(PaymentAuthorization).where(PaymentAuthorization.status == "ACTIVE", PaymentAuthorization.payment_session_id.in_(ids)).values(status="REVOKED")
    )
    db.execute(update(PaymentSession).where(PaymentSession.payment_request_id == request_pk, PaymentSession.status.in_(PAYABLE_SESSION)).values(status="CANCELLED"))


def expire_overdue(db: Session) -> None:
    """PENDING requests past their deadline become EXPIRED (committed)."""
    t = now()
    overdue = db.scalars(select(PaymentRequest.id).where(PaymentRequest.status == "PENDING", PaymentRequest.expires_at <= t)).all()
    for pk in overdue:
        _close_open_payments(db, pk)
    if overdue:
        db.execute(update(PaymentRequest).where(PaymentRequest.id.in_(overdue), PaymentRequest.status == "PENDING").values(status="EXPIRED", resolved_at=t))
        db.commit()


def lock(db: Session, request_pk: int) -> PaymentRequest:
    """Locks the request's unfinished payment session first and the request second. payment_service.confirm locks in
    the same order (session, then request), so the two can never wait on each other."""
    db.scalars(select(PaymentSession.id).where(PaymentSession.payment_request_id == request_pk, PaymentSession.status.in_(PAYABLE_SESSION)).with_for_update()).all()
    return db.scalar(select(PaymentRequest).where(PaymentRequest.id == request_pk).with_for_update().execution_options(populate_existing=True))


# ------------------------------------------------------------------ views


def _out(db: Session, req: PaymentRequest, viewer: User) -> dict:
    incoming = req.payer_id == viewer.id
    other = db.get(User, req.requester_id if incoming else req.payer_id)
    txn_ref = db.scalar(select(Transaction.transaction_id).where(Transaction.id == req.transaction_id)) if req.transaction_id else None
    return {
        "request_id": req.request_id,
        "direction": "INCOMING" if incoming else "OUTGOING",
        "status": req.status,
        "amount": req.amount,
        "currency": req.currency,
        "note": req.note,
        "created_at": req.created_at,
        "expires_at": req.expires_at,
        "resolved_at": req.resolved_at,
        "counterparty_name": other.name,
        "counterparty_masked_id": fid.mask(other.facepay_id),
        "payable": incoming and req.status == "PENDING" and req.expires_at > now(),
        "transaction_id": txn_ref,
        "qr_payload": f"{facepay_service.QR_SCHEME}request/{req.request_id}",
    }


def _participant_request(db: Session, viewer: User, ref: str) -> PaymentRequest:
    req = db.scalar(
        select(PaymentRequest).where(PaymentRequest.request_id == ref, or_(PaymentRequest.requester_id == viewer.id, PaymentRequest.payer_id == viewer.id))
    )
    if req is None:
        raise _not_found()
    return req


def view(db: Session, viewer: User, ref: str) -> dict:
    expire_overdue(db)
    req = _participant_request(db, viewer, ref)
    db.refresh(req)
    return _out(db, req, viewer)


def list_requests(db: Session, user: User, *, box: str, status: str | None, limit: int, offset: int) -> list[dict]:
    expire_overdue(db)
    q = select(PaymentRequest)
    if box == "incoming":
        q = q.where(PaymentRequest.payer_id == user.id)
    elif box == "outgoing":
        q = q.where(PaymentRequest.requester_id == user.id)
    else:
        q = q.where(or_(PaymentRequest.requester_id == user.id, PaymentRequest.payer_id == user.id))
    if status:
        q = q.where(PaymentRequest.status == status)
    rows = db.scalars(q.order_by(PaymentRequest.id.desc()).limit(limit).offset(offset)).all()
    return [_out(db, r, user) for r in rows]


def pending_incoming_count(db: Session, user: User) -> int:
    expire_overdue(db)
    return db.scalar(select(func.count()).select_from(PaymentRequest).where(PaymentRequest.payer_id == user.id, PaymentRequest.status == "PENDING")) or 0


# ------------------------------------------------------------------ actions


def create(db: Session, requester: User, *, payer_facepay_id: str, amount: Decimal, note: str | None) -> dict:
    s = get_settings()
    payer = facepay_service.find_active(db, payer_facepay_id)
    if payer is None:
        raise _err(404, "RECIPIENT_NOT_FOUND", "No FacePay account matches that ID. Check it and try again.")
    if payer.id == requester.id:
        raise _err(422, "SELF_REQUEST", "You cannot request money from yourself.")
    if amount > s.per_transaction_limit:
        raise _err(422, "PER_TRANSACTION_LIMIT", f"The simulated limit is ₹{s.per_transaction_limit:,.0f} per payment.")
    pending = select(func.count()).select_from(PaymentRequest).where(PaymentRequest.requester_id == requester.id, PaymentRequest.status == "PENDING")
    if (db.scalar(pending) or 0) >= MAX_PENDING_OUTGOING:
        raise _err(429, "TOO_MANY_PENDING_REQUESTS", "You have too many unpaid requests. Cancel some or wait for them to be paid.")
    if (db.scalar(pending.where(PaymentRequest.payer_id == payer.id)) or 0) >= MAX_PENDING_PER_PAIR:
        raise _err(429, "TOO_MANY_PENDING_REQUESTS", "You already have several unpaid requests to this person.")
    req = PaymentRequest(
        request_id="pr_" + secrets.token_urlsafe(12),
        requester_id=requester.id,
        payer_id=payer.id,
        amount=amount,
        currency="INR",
        note=note or None,
        status="PENDING",
        expires_at=now() + timedelta(days=s.request_ttl_days),
    )
    db.add(req)
    sec.record_event(db, requester, "MONEY_REQUESTED", req.request_id)
    db.commit()
    db.refresh(req)
    return _out(db, req, requester)


def _actor_action(db: Session, user: User, ref: str, *, as_payer: bool, new_status: str, event: str) -> dict:
    expire_overdue(db)
    req = _participant_request(db, user, ref)
    if (req.payer_id == user.id) != as_payer:  # only the asked customer declines; only the sender cancels
        raise _err(403, "REQUEST_FORBIDDEN", "You cannot do that with this request.")
    req = lock(db, req.id)
    try:
        transition(req, new_status)
    except HTTPException:
        db.commit()
        raise
    _close_open_payments(db, req.id)
    sec.record_event(db, user, event, req.request_id)
    db.commit()
    db.refresh(req)
    return _out(db, req, user)


def decline(db: Session, user: User, ref: str) -> dict:
    return _actor_action(db, user, ref, as_payer=True, new_status="DECLINED", event="MONEY_REQUEST_DECLINED")


def cancel(db: Session, user: User, ref: str) -> dict:
    return _actor_action(db, user, ref, as_payer=False, new_status="CANCELLED", event="MONEY_REQUEST_CANCELLED")
