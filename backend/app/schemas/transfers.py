from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from typing import Annotated

from app.core import purposes
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
    purpose: str | None = None
    purpose_label: str | None = None
    source: str | None = None  # ID | FACE
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
    """What the payer chooses. The recipient is re-resolved on the server, and limits are checked there."""

    model_config = ConfigDict(extra="forbid")

    recipient_facepay_id: IdText
    amount: Money
    note: Note | None = None


class RequestCreate(BaseModel):
    """Ask a customer for money. Name them by FacePay ID OR by a face-scan ticket (exactly one). The purpose and the
    reference are required: they are what the person asked sees first, and they make scam requests harder."""

    model_config = ConfigDict(extra="forbid")

    payer_facepay_id: IdText | None = None
    lookup_token: str | None = Field(default=None, min_length=10, max_length=80)
    amount: Money
    purpose: str
    note: str  # the reference

    @field_validator("purpose")
    @classmethod
    def _purpose(cls, v: str) -> str:
        return purposes.clean_purpose(v)

    @field_validator("note")
    @classmethod
    def _note(cls, v: str) -> str:
        return purposes.clean_reference(v)

    @model_validator(mode="after")
    def _exactly_one_recipient(self):
        if (self.payer_facepay_id is None) == (self.lookup_token is None):
            raise ValueError("Say who to ask: a FacePay ID or a face scan.")
        return self


class CancelOut(BaseModel):
    session_id: str
    status: str


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
    # The simulated bank account a SENT payment was made from ("HDFC Bank · DEMO-••••-4821"). Never shown to the recipient.
    funding_source: str | None = None


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


class IncomingItem(BaseModel):
    """One thing waiting for the signed-in customer to approve: a customer's money request (REQUEST) or a bill a shop addressed
    to them (SHOP). `reference` is what the sender wrote it is for."""

    kind: str  # REQUEST | SHOP
    ref: str  # request_id for REQUEST, session_id for SHOP
    from_name: str
    from_detail: str  # masked FacePay ID, or "Shop"
    amount: Decimal
    currency: str
    purpose: str | None
    purpose_label: str | None
    reference: str | None
    created_at: datetime
    expires_at: datetime
