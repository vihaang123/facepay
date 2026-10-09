from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing import Annotated

from app.schemas.payments import Money

Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=140)]
IdText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]


class FacePayProfile(BaseModel):
    facepay_id: str
    masked_id: str
    display_name: str
    qr_payload: str
    can_change: bool
    next_change_at: datetime | None


class ChangeIdRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    facepay_id: IdText


class ResolveOut(BaseModel):
    """Only what is needed to recognise the recipient. No email, phone or internal id."""

    display_name: str
    masked_id: str
    is_self: bool


class RequestOut(BaseModel):
    request_id: str
    direction: str  # INCOMING (you were asked to pay) | OUTGOING (you asked)
    status: str
    amount: Decimal
    currency: str
    note: str | None
    created_at: datetime
    expires_at: datetime
    resolved_at: datetime | None
    counterparty_name: str
    counterparty_masked_id: str
    payable: bool
    transaction_id: str | None
    qr_payload: str


class QrResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload: str = Field(min_length=1, max_length=200)


class QrResolveOut(BaseModel):
    type: str  # PAY | REQUEST
    facepay_id: str | None
    recipient: ResolveOut | None
    request: RequestOut | None


class ContactOut(BaseModel):
    display_name: str
    facepay_id: str
    masked_id: str
    last_activity_at: datetime


class TransferCreate(BaseModel):
    """What the payer chooses. The recipient is re-resolved on the server, and limits and balance are checked there."""

    model_config = ConfigDict(extra="forbid")

    recipient_facepay_id: IdText
    amount: Money
    note: Note | None = None


class RequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payer_facepay_id: IdText
    amount: Money
    note: Note | None = None


class CancelOut(BaseModel):
    session_id: str
    status: str


class LedgerLine(BaseModel):
    direction: str
    amount: Decimal
    balance_after: Decimal
    kind: str
    created_at: datetime


class WalletOut(BaseModel):
    balance: Decimal
    currency: str
    simulated: bool
    entries: list[LedgerLine]


class ActivityItem(BaseModel):
    ref: str
    kind: str  # MERCHANT_PAYMENT | TRANSFER | REQUEST
    direction: str  # SENT | RECEIVED | REQUESTED | REQUEST_RECEIVED
    status: str  # SUCCESS | FAILED | PENDING | CANCELLED | DECLINED | EXPIRED
    counterparty_name: str | None
    counterparty_masked_id: str | None
    amount: Decimal
    currency: str
    timestamp: datetime
    note: str | None
    order_reference: str | None


class ActivityDetail(ActivityItem):
    sender_name: str
    sender_masked_id: str | None
    recipient_name: str | None
    recipient_masked_id: str | None
    payment_method: str
    authentication: str
    request_id: str | None


class ActivityCounts(BaseModel):
    pending_incoming_requests: int


class AdminJson(BaseModel):
    """Admin analytics are read-only JSON built from stored results (see admin_service); the shape is documented there."""

    model_config = ConfigDict(extra="allow")


AdminPayload = dict[str, Any]
