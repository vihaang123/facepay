from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class BankInfo(BaseModel):
    code: str
    name: str
    short: str
    color: str


class AccountTypeInfo(BaseModel):
    code: str
    label: str


class BehaviorInfo(BaseModel):
    code: str
    label: str


class BankCatalogOut(BaseModel):
    banks: list[BankInfo]
    account_types: list[AccountTypeInfo]
    max_connected: int
    behaviors: list[BehaviorInfo]
    behavior_note: str
    disclaimer: str


class BankConnectRequest(BaseModel):
    """Only a bank code and an account type: the name and reference are created by the server. No credentials, ever."""

    model_config = ConfigDict(extra="forbid")

    bank_code: str = Field(min_length=2, max_length=24)
    account_type: str = Field(min_length=2, max_length=20)


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
