from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class AttemptSummary(BaseModel):
    timestamp: datetime
    result: str  # SUCCESS | FAILED
    category: str | None  # what kind of check failed; never whose face it was
    payment_session_ref: str | None
    transaction_ref: str | None


class TransactionSummary(BaseModel):
    transaction_id: str
    merchant_name: str
    amount: Decimal
    timestamp: datetime


class EventSummary(BaseModel):
    kind: str
    timestamp: datetime
    session_ref: str | None


class Limits(BaseModel):
    currency: str
    per_transaction: Decimal
    daily: Decimal
    spent_last_24h: Decimal
    step_up_amount: Decimal
    authorization_seconds: int


class SecurityOverview(BaseModel):
    biometric_enabled: bool
    face_enrolled: bool
    samples_stored: int
    last_successful_authentication: datetime | None
    biometric_locked_seconds: int
    pin_set: bool
    pin_locked_seconds: int
    recent_attempts: list[AttemptSummary]
    recent_transactions: list[TransactionSummary]
    recent_events: list[EventSummary]
    limits: Limits
    risk_label: str


class BiometricToggle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class SetPin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=128)
    new_pin: str = Field(min_length=1, max_length=12)


class PasswordOnly(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=128)
