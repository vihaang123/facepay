import re
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, field_validator

_PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
BusinessName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


def _validate_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    if len(v) > 128:
        raise ValueError("Password must be at most 128 characters")
    if not re.search(r"[A-Za-z]", v) or not re.search(r"[0-9]", v):
        raise ValueError("Password must contain at least one letter and one number")
    return v


class _EmailMixin(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, v: str) -> str:
        return v.strip().lower()


class CustomerRegister(_EmailMixin):
    name: Name
    phone: str | None = None
    password: str

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        return _validate_password(v)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        return _normalize_phone(v)


class MerchantRegister(_EmailMixin):
    name: Name
    business_name: BusinessName
    password: str

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        return _validate_password(v)


class LoginRequest(_EmailMixin):
    # No strength rules on login: only check the credentials.
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    role: str


def _normalize_phone(v: str | None) -> str | None:
    if v is None:
        return None
    cleaned = re.sub(r"[\s\-()]", "", v)
    if cleaned == "":
        return None
    if not _PHONE_RE.match(cleaned):
        raise ValueError("Phone must be 7 to 15 digits, optionally starting with +")
    return cleaned


class UserUpdate(BaseModel):
    """Only these fields are editable. Email, role and status are not."""

    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    phone: str | None = None

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        return _normalize_phone(v)


class MerchantUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    business_name: BusinessName | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    facepay_id: str
    phone: str | None
    role: str
    status: str
    created_at: datetime


class MerchantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    business_name: str
    created_at: datetime
