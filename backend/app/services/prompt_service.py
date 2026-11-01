"""What is waiting for a customer to approve: money requests from other customers and bills a shop addressed to them.

The app asks for this list every few seconds while it is open and shows the newest as a pop-up. It is read-only: approving
means opening the request and passing the normal face check and confirmation, declining uses the normal decline routes."""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import facepay_id as fid
from app.core import purposes
from app.models import Merchant, PaymentRequest, PaymentSession, User

PAYABLE = ("CREATED", "AUTHENTICATED")
LIMIT = 10


def incoming(db: Session, user: User) -> list[dict]:
    now = datetime.now(UTC)
    items: list[dict] = []

    for req, requester in db.execute(
        select(PaymentRequest, User)
        .join(User, User.id == PaymentRequest.requester_id)
        .where(PaymentRequest.payer_id == user.id, PaymentRequest.status == "PENDING", PaymentRequest.expires_at > now)
        .order_by(PaymentRequest.id.desc())
        .limit(LIMIT)
    ):
        items.append({
            "kind": "REQUEST", "ref": req.request_id, "from_name": requester.name, "from_detail": fid.mask(requester.facepay_id),
            "amount": req.amount, "currency": req.currency, "purpose": req.purpose, "purpose_label": purposes.purpose_label(req.purpose),
            "reference": req.note, "created_at": req.created_at, "expires_at": req.expires_at,
        })

    for ps, merchant in db.execute(
        select(PaymentSession, Merchant)
        .join(Merchant, Merchant.id == PaymentSession.merchant_id)
        .where(
            PaymentSession.kind == "MERCHANT", PaymentSession.payer_user_id == user.id,
            PaymentSession.status.in_(PAYABLE), PaymentSession.expires_at > now,
        )
        .order_by(PaymentSession.id.desc())
        .limit(LIMIT)
    ):
        items.append({
            "kind": "SHOP", "ref": ps.session_id, "from_name": merchant.business_name, "from_detail": "Shop",
            "amount": ps.amount, "currency": ps.currency, "purpose": ps.purpose, "purpose_label": purposes.purpose_label(ps.purpose),
            "reference": ps.order_reference, "created_at": ps.created_at, "expires_at": ps.expires_at,
        })

    items.sort(key=lambda i: i["created_at"], reverse=True)
    return items[:LIMIT]
