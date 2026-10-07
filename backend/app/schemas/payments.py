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


class CheckoutOut(BaseModel):
    """What the paying customer may see about a session: no merchant contact details."""

    session_id: str
    merchant_name: str
    order_reference: str | None
    description: str | None
    amount: Decimal
    currency: str
    status: str
    expires_at: datetime | None
    max_auth_attempts: int
    attempts_remaining: int


class AuthorizationOut(BaseModel):
    authorization_token: str  # shown once; the server keeps only its hash
    expires_in_seconds: int
    expires_at: datetime


class PaymentAuthResult(AuthResult):
    """The Phase 4 decision plus the payment-session consequences."""

    session_status: str
    attempts_remaining: int
    authorization: AuthorizationOut | None = None


class PaymentVerifyRequest(VerifyRequest):
    model_config = ConfigDict(extra="forbid")


class ConfirmRequest(BaseModel):
    """Only the ticket and, optionally, the amount the customer was shown. The amount that is charged is always
    the one stored in the payment session; a different expected_amount is refused."""

    model_config = ConfigDict(extra="forbid")

    authorization_token: str = Field(min_length=20, max_length=128)
    expected_amount: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)


class ReceiptOut(BaseModel):
    transaction_id: str
    status: str
    amount: Decimal
    currency: str
    payment_method: str
    timestamp: datetime
    payer_name: str
    merchant_name: str
    order_reference: str | None
    description: str | None
    session_id: str | None


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
