from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.core import mobile as mobile_rules

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
BusinessName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class _Mobile(BaseModel):
    mobile: str

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v: str) -> str:
        try:
            return mobile_rules.normalize(v)
        except mobile_rules.InvalidMobile as exc:
            raise ValueError(str(exc)) from None


class OtpRequest(_Mobile):
    # "claim" is the same code step for an older email account adding its number.
    purpose: Literal["signup", "claim"] = "signup"


class OtpChallengeOut(BaseModel):
    challenge_id: str
    mobile_masked: str
    expires_in: int
    resend_in: int
    demo: bool
    # Present only while demo mode is on. FacePay sends no SMS, so this is how the code reaches the screen.
    demo_code: str | None = None


class OtpVerify(BaseModel):
    challenge_id: str = Field(min_length=8, max_length=64)
    code: str = Field(pattern=r"^[0-9]{6}$")


class OtpVerified(BaseModel):
    verified: bool = True


class _Passcode(BaseModel):
    passcode: str

    @field_validator("passcode")
    @classmethod
    def _passcode(cls, v: str) -> str:
        return mobile_rules.check_passcode(v)


class NumberSignup(_Passcode):
    challenge_id: str = Field(min_length=8, max_length=64)
    account_type: Literal["customer", "merchant"] = "customer"
    name: Name
    business_name: BusinessName | None = None
    # The explicit "this is a simulated prototype" agreement, as on the older sign-up form.
    agreed: bool = False


class NumberSignin(_Mobile):
    # No strength rules here: only check the passcode, so a wrong-format guess costs the same as a wrong one.
    passcode: str = Field(min_length=1, max_length=12)


class NumberClaim(_Passcode):
    challenge_id: str = Field(min_length=8, max_length=64)


class NumberAccount(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    mobile: str | None
    mobile_masked: str | None
