from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.face_auth import AuthResult, VerifyRequest

Money = Annotated[Decimal, Field(gt=0, le=1_000_000, max_digits=12, decimal_places=2)]
Reference = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)]


class SessionCreate(BaseModel):
    """What a merchant may choose. The payer, status and ids are never client-controlled."""

    model_config = ConfigDict(extra="forbid")

    amount: Money
    order_reference: Reference
    description: Description | None = None
    expires_in_minutes: int = Field(default=15, ge=1, le=60)
    # Show this request in the simulated "nearby" list for customers (a demo of discovery; no location is used).
    discoverable: bool = False


class DisplayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    discoverable: bool


class MerchantSessionOut(BaseModel):
    session_id: str
    amount: Decimal
    currency: str
    order_reference: str | None
    description: str | None
    status: str
    created_at: datetime
    expires_at: datetime | None
    checkout_path: str
    transaction_id: str | None = None  # set once paid
    discoverable: bool = False
    paid_at: datetime | None = None  # the backend transaction's timestamp: the only proof a request was paid


class FundingSourceOut(BaseModel):
    connection_id: str
    bank_code: str
    bank_name: str
    account_type_label: str
    account_ref: str  # DEMO-••••-1234
    is_default: bool


class CheckoutOut(BaseModel):
    """What the paying customer may see about a payment: no merchant contact details, and for a customer-to-customer
    payment only the recipient's name and FacePay ID (their public payment handle)."""

    session_id: str
    kind: str = "MERCHANT"  # MERCHANT | TRANSFER
    merchant_name: str | None = None
    recipient_name: str | None = None
    recipient_facepay_id: str | None = None
    recipient_masked_id: str | None = None
    note: str | None = None
    request_id: str | None = None  # set when this payment answers a money request
    fee: Decimal = Decimal("0.00")  # simulated; FacePay charges nothing
    total: Decimal | None = None  # amount + fee
    funding_sources: list["FundingSourceOut"] = []  # the signed-in customer's OWN demo bank accounts
    order_reference: str | None
    description: str | None
    amount: Decimal
    currency: str
    status: str
    expires_at: datetime | None
    max_auth_attempts: int
    attempts_remaining: int
    authorization_seconds: int


class AuthorizationOut(BaseModel):
    authorization_token: str  # shown once; the server keeps only its hash
    expires_in_seconds: int
    expires_at: datetime
    # Risk-based authorization PROTOTYPE: when true, confirming also needs the payment PIN.
    step_up_required: bool = False
    step_up_reasons: list[str] = []  # plain-language reasons, never internal scores
    pin_set: bool = False


class PaymentAuthResult(AuthResult):
    """The Phase 4 decision plus the payment-session consequences."""

    session_status: str
    attempts_remaining: int
    authorization: AuthorizationOut | None = None


class PaymentVerifyRequest(VerifyRequest):
    model_config = ConfigDict(extra="forbid")


class ConfirmRequest(BaseModel):
    """The customer's explicit confirmation: the authorization ticket plus what they were shown. A merchant bill needs
    the amount, merchant and order; a customer-to-customer payment needs the amount and the recipient's FacePay ID.
    All must match the payment, which alone decides what is charged. A payment PIN is needed only when the
    authorization says step-up is required."""

    model_config = ConfigDict(extra="forbid")

    authorization_token: str = Field(min_length=20, max_length=128)
    expected_amount: Decimal = Field(max_digits=14, decimal_places=2)
    expected_merchant: str | None = Field(default=None, max_length=160)
    expected_order_reference: str | None = Field(default=None, max_length=80)
    expected_recipient: str | None = Field(default=None, max_length=60)
    pin: str | None = Field(default=None, max_length=12)
    # Which of the customer's own demo bank accounts to pay from; the default is used when omitted. The server checks it.
    funding_source_id: str | None = Field(default=None, min_length=4, max_length=40)


class ReceiptFunding(BaseModel):
    bank_name: str
    account_ref: str


class ReceiptOut(BaseModel):
    transaction_id: str
    kind: str = "MERCHANT_PAYMENT"  # MERCHANT_PAYMENT | TRANSFER
    status: str
    amount: Decimal
    currency: str
    payment_method: str
    timestamp: datetime
    payer_name: str
    payer_masked_id: str | None = None
    merchant_name: str | None = None
    recipient_name: str | None = None  # for a transfer
    recipient_masked_id: str | None = None
    order_reference: str | None
    description: str | None
    note: str | None = None
    request_id: str | None = None
    session_id: str | None
    authentication: str  # e.g. "Face + basic liveness check"
    fee: Decimal = Decimal("0.00")
    total: Decimal | None = None
    # The payer's own demo bank account. None for the recipient and the merchant, who never see the payer's account.
    funding_source: "ReceiptFunding | None" = None
    simulation_notice: str = "Simulated payment. No real bank account was accessed and no money was transferred."


class CustomerTransactionOut(BaseModel):
    transaction_id: str
    status: str
    amount: Decimal
    currency: str
    payment_method: str
    timestamp: datetime
    merchant_name: str
    order_reference: str | None


class MerchantTransactionOut(BaseModel):
    transaction_id: str
    status: str
    amount: Decimal
    currency: str
    payment_method: str
    timestamp: datetime
    payer_name: str
    order_reference: str | None
    session_id: str | None


class DayRevenue(BaseModel):
    date: date
    revenue: Decimal
    count: int


class MerchantSummary(BaseModel):
    currency: str
    total_revenue: Decimal  # SUCCESS transactions only (simulated)
    transactions: int  # all transaction rows
    successful_payments: int
    failed_payments: int  # FAILED transactions + sessions that ended FAILED
    open_sessions: int  # CREATED or AUTHENTICATED
    expired_sessions: int
    cancelled_sessions: int
    revenue_by_day: list[DayRevenue]


class CustomerSummary(BaseModel):
    currency: str
    total_spent: Decimal  # SUCCESS transactions only (simulated)
    payments: int
    spent_last_30_days: Decimal
    last_payment_at: datetime | None


class MerchantSecuritySummary(BaseModel):
    """Aggregate authentication outcomes for ONE merchant's own payment sessions. No customer is identified and no
    biometric detail is included."""

    sessions: int
    paid: int
    closed_after_failed_face_checks: int
    cancelled: int
    expired: int
    face_verified_sessions: int
    paid_with_pin_step_up: int
    note: str


class NearbyRequestOut(BaseModel):
    """A merchant payment request the merchant chose to display (simulated discovery). Opening it is an ordinary checkout."""

    session_id: str
    merchant_name: str
    amount: Decimal
    currency: str
    order_reference: str | None
    description: str | None
    expires_at: datetime | None
    checkout_path: str


class ReconciliationRow(BaseModel):
    session_id: str
    order_reference: str | None
    amount: Decimal
    status: str
    transaction_id: str | None
    paid_at: datetime | None
    created_at: datetime


class ReconciliationOut(BaseModel):
    """Payment requests against the backend transactions that settled them. 'Paid' means a SUCCESS transaction exists."""

    currency: str
    requested_total: Decimal  # every request ever created
    paid_total: Decimal  # SUCCESS transactions
    awaiting_total: Decimal  # open (CREATED / AUTHENTICATED) requests
    mismatches: int  # paid sessions without exactly one SUCCESS transaction of the same amount (should be 0)
    rows: list[ReconciliationRow]
