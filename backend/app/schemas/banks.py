from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class BankInfo(BaseModel):
    code: str
    name: str
    short: str
    color: str


class BehaviorInfo(BaseModel):
    code: str
    label: str


class BankCatalogOut(BaseModel):
    banks: list[BankInfo]
    max_connected: int
    behaviors: list[BehaviorInfo]
    behavior_note: str
    disclaimer: str


class BankConnectRequest(BaseModel):
    """Only the bank. The holder name, account type, number, IFSC and branch are found by the server's discovery provider and
    cannot be supplied. No credential, PIN, card detail, Aadhaar number or bank OTP is accepted (unknown fields are refused)."""

    model_config = ConfigDict(extra="forbid")

    bank_code: str = Field(min_length=2, max_length=24)


class BankConnectionOut(BaseModel):
    connection_id: str
    bank_code: str
    bank_name: str
    account_type: str
    account_type_label: str
    account_ref: str
    is_default: bool
    status: str
    connected_at: datetime
    holder_name: str | None = None
    ifsc: str | None = None
    branch: str | None = None
    discovery_source: str | None = None
    link_status: str = "LINKED"
    link_status_label: str = "Linked"
    sim_behavior: str
    sim_behavior_label: str
    disclaimer: str


class BankDisconnectOut(BaseModel):
    connection_id: str
    status: str


class BankBehaviorRequest(BaseModel):
    """Only one of the fixed behaviours; anything else is refused."""

    model_config = ConfigDict(extra="forbid")

    behavior: str = Field(min_length=2, max_length=12)
