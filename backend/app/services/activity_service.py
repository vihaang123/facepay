"""The customer's own history, assembled from real records: completed payments and transfers (sent and received),
money requests (pending, declined, cancelled, expired) and payments that failed or were cancelled. Every query is
scoped to the signed-in customer; another customer's history is unreachable by any parameter."""

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session, aliased

from fastapi import HTTPException

from app.core import facepay_id as fid
from app.models import AuthenticationLog, Merchant, PaymentRequest, PaymentSession, Transaction, User
from app.services import request_service
from app.services.payment_service import _authentication_label, _like

FILTERS = ("all", "sent", "received", "successful", "failed", "pending", "cancelled")

REQUEST_STATUS = {"PENDING": "PENDING", "DECLINED": "DECLINED", "CANCELLED": "CANCELLED", "EXPIRED": "EXPIRED"}


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def _transactions(db: Session, user: User, flt: str, q: str | None, cap: int) -> list[dict]:
    if flt in ("failed", "pending", "cancelled"):
        return []
    payer, recipient = aliased(User), aliased(User)
    query = (
        select(Transaction, payer.name, payer.facepay_id, recipient.name, recipient.facepay_id, Merchant.business_name, PaymentSession.order_reference)
        .join(payer, payer.id == Transaction.payer_id)
        .outerjoin(recipient, recipient.id == Transaction.recipient_id)
        .outerjoin(Merchant, Merchant.id == Transaction.merchant_id)
        .outerjoin(PaymentSession, PaymentSession.id == Transaction.payment_session_id)
    )
    mine = or_(Transaction.payer_id == user.id, Transaction.recipient_id == user.id)
    if flt == "sent":
        mine = Transaction.payer_id == user.id
    elif flt == "received":
        mine = Transaction.recipient_id == user.id
    query = query.where(mine)
    if flt == "successful":
        query = query.where(Transaction.status == "SUCCESS")
    if q:
        query = query.where(
            or_(
                _like(Transaction.transaction_id, q), _like(payer.name, q), _like(recipient.name, q), _like(Merchant.business_name, q),
                _like(Transaction.note, q), _like(PaymentSession.order_reference, q),
            )
        )
    out = []
    for t, payer_name, payer_id, recipient_name, recipient_id, merchant_name, order_ref in db.execute(query.order_by(Transaction.id.desc()).limit(cap)):
        sent = t.payer_id == user.id
        if sent:
            other_name = merchant_name or recipient_name
            other_id = fid.mask(recipient_id) if recipient_id else None
        else:
            other_name, other_id = payer_name, fid.mask(payer_id)
        out.append(
            {
                "ref": t.transaction_id,
                "kind": t.kind,
                "direction": "SENT" if sent else "RECEIVED",
                "status": t.status,
                "counterparty_name": other_name,
                "counterparty_masked_id": other_id,
                "amount": t.amount,
                "currency": t.currency,
                "timestamp": t.timestamp,
                "note": t.note,
                "order_reference": order_ref,
            }
        )
    return out


def _requests(db: Session, user: User, flt: str, q: str | None, cap: int) -> list[dict]:
    if flt in ("sent", "received", "successful", "failed"):
        return []
    requester, payer = aliased(User), aliased(User)
    query = (
        select(PaymentRequest, requester.name, requester.facepay_id, payer.name, payer.facepay_id)
        .join(requester, requester.id == PaymentRequest.requester_id)
        .join(payer, payer.id == PaymentRequest.payer_id)
        .where(or_(PaymentRequest.requester_id == user.id, PaymentRequest.payer_id == user.id), PaymentRequest.status != "PAID")  # a paid request shows as its transaction
    )
    if flt == "pending":
        query = query.where(PaymentRequest.status == "PENDING")
    elif flt == "cancelled":
        query = query.where(PaymentRequest.status != "PENDING")
    if q:
        query = query.where(or_(_like(PaymentRequest.request_id, q), _like(requester.name, q), _like(payer.name, q), _like(PaymentRequest.note, q)))
    out = []
    for r, requester_name, requester_fid, payer_name, payer_fid in db.execute(query.order_by(PaymentRequest.id.desc()).limit(cap)):
        incoming = r.payer_id == user.id
        out.append(
            {
                "ref": r.request_id,
                "kind": "REQUEST",
                "direction": "REQUEST_RECEIVED" if incoming else "REQUESTED",
                "status": REQUEST_STATUS[r.status],
                "counterparty_name": requester_name if incoming else payer_name,
                "counterparty_masked_id": fid.mask(requester_fid if incoming else payer_fid),
                "amount": r.amount,
                "currency": r.currency,
                "timestamp": r.created_at,
                "note": r.note,
                "order_reference": None,
            }
        )
    return out


def _attempts(db: Session, user: User, flt: str, q: str | None, cap: int) -> list[dict]:
    """Payments that did not complete: closed after too many failed face checks, or cancelled. Merchant bills only
    appear for customers who actually tried to pay them."""
    if flt in ("sent", "received", "successful", "pending"):
        return []
    wanted = ("FAILED",) if flt == "failed" else ("CANCELLED",) if flt == "cancelled" else ("FAILED", "CANCELLED")
    tried = exists().where(AuthenticationLog.user_id == user.id, AuthenticationLog.payment_session_ref == PaymentSession.session_id)
    payee, merchant = aliased(User), aliased(Merchant)
    query = (
        select(PaymentSession, payee.name, payee.facepay_id, merchant.business_name)
        .outerjoin(payee, payee.id == PaymentSession.payee_user_id)
        .outerjoin(merchant, merchant.id == PaymentSession.merchant_id)
        .where(PaymentSession.status.in_(wanted), or_(PaymentSession.payer_user_id == user.id, and_(PaymentSession.kind == "MERCHANT", tried)))
    )
    if q:
        query = query.where(or_(_like(PaymentSession.session_id, q), _like(payee.name, q), _like(merchant.business_name, q), _like(PaymentSession.description, q), _like(PaymentSession.order_reference, q)))
    out = []
    for ps, payee_name, payee_fid, merchant_name in db.execute(query.order_by(PaymentSession.id.desc()).limit(cap)):
        out.append(
            {
                "ref": ps.session_id,
                "kind": "MERCHANT_PAYMENT" if ps.kind == "MERCHANT" else "TRANSFER",
                "direction": "SENT",
                "status": ps.status,
                "counterparty_name": merchant_name or payee_name,
                "counterparty_masked_id": fid.mask(payee_fid) if payee_fid else None,
                "amount": ps.amount,
                "currency": ps.currency,
                "timestamp": ps.created_at,
                "note": ps.description if ps.kind == "TRANSFER" else None,
                "order_reference": ps.order_reference,
            }
        )
    return out


def history(db: Session, user: User, *, flt: str, q: str | None, limit: int, offset: int) -> list[dict]:
    request_service.expire_overdue(db)
    cap = offset + limit
    items = _transactions(db, user, flt, q, cap) + _requests(db, user, flt, q, cap) + _attempts(db, user, flt, q, cap)
    items.sort(key=lambda i: (i["timestamp"], i["ref"]), reverse=True)
    return items[offset : offset + limit]


def counts(db: Session, user: User) -> dict:
    """Small numbers for the home screen; derived from the same records."""
    return {"pending_incoming_requests": request_service.pending_incoming_count(db, user)}


# ------------------------------------------------------------------ detail


def detail(db: Session, user: User, ref: str) -> dict:
    request_service.expire_overdue(db)
    if ref.startswith("FP-"):
        txn = db.scalar(select(Transaction).where(Transaction.transaction_id == ref, or_(Transaction.payer_id == user.id, Transaction.recipient_id == user.id)))
        if txn is None:
            raise _err(404, "TRANSACTION_NOT_FOUND", "Transaction not found.")
        payer = db.get(User, txn.payer_id)
        recipient = db.get(User, txn.recipient_id) if txn.recipient_id else None
        merchant = db.get(Merchant, txn.merchant_id) if txn.merchant_id else None
        ps = db.get(PaymentSession, txn.payment_session_id) if txn.payment_session_id else None
        req = db.scalar(select(PaymentRequest.request_id).where(PaymentRequest.transaction_id == txn.id))
        return {
            "ref": txn.transaction_id,
            "kind": txn.kind,
            "direction": "SENT" if txn.payer_id == user.id else "RECEIVED",
            "status": txn.status,
            "amount": txn.amount,
            "currency": txn.currency,
            "timestamp": txn.timestamp,
            "note": txn.note,
            "counterparty_name": (merchant.business_name if merchant else recipient.name) if txn.payer_id == user.id else payer.name,
            "counterparty_masked_id": (fid.mask(recipient.facepay_id) if recipient else None) if txn.payer_id == user.id else fid.mask(payer.facepay_id),
            "sender_name": payer.name,
            "sender_masked_id": fid.mask(payer.facepay_id),
            "recipient_name": merchant.business_name if merchant else recipient.name,
            "recipient_masked_id": fid.mask(recipient.facepay_id) if recipient else None,
            "payment_method": "FacePay (simulated)",
            "authentication": _authentication_label(db, ps),
            "order_reference": ps.order_reference if ps else None,
            "request_id": req,
        }
    if ref.startswith("pr_"):
        view = request_service.view(db, user, ref)
        other_is_sender = view["direction"] == "INCOMING"  # I was asked to pay: I would be the sender
        me_name, me_id = user.name, fid.mask(user.facepay_id)
        return {
            "ref": view["request_id"],
            "kind": "REQUEST",
            "direction": "REQUEST_RECEIVED" if other_is_sender else "REQUESTED",
            "status": view["status"],
            "amount": view["amount"],
            "currency": view["currency"],
            "timestamp": view["created_at"],
            "note": view["note"],
            "counterparty_name": view["counterparty_name"],
            "counterparty_masked_id": view["counterparty_masked_id"],
            "sender_name": me_name if other_is_sender else view["counterparty_name"],
            "sender_masked_id": me_id if other_is_sender else view["counterparty_masked_id"],
            "recipient_name": view["counterparty_name"] if other_is_sender else me_name,
            "recipient_masked_id": view["counterparty_masked_id"] if other_is_sender else me_id,
            "payment_method": "FacePay (simulated)",
            "authentication": "Not paid yet" if view["status"] != "PAID" else "Face + basic liveness check",
            "order_reference": None,
            "request_id": view["request_id"],
        }
    rows = _attempts(db, user, "all", ref, 5)
    match = next((r for r in rows if r["ref"] == ref), None)
    if match is None:
        raise _err(404, "TRANSACTION_NOT_FOUND", "Transaction not found.")
    return {
        **match,
        "sender_name": user.name,
        "sender_masked_id": fid.mask(user.facepay_id),
        "recipient_name": match["counterparty_name"],
        "recipient_masked_id": match["counterparty_masked_id"],
        "payment_method": "FacePay (simulated)",
        "authentication": "Payment not completed",
        "request_id": None,
    }
