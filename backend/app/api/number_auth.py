"""Mobile-number sign-up and sign-in. See app/services/number_auth_service.py for what is and is not claimed."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_customer_or_merchant
from app.core import mobile as mobile_rules
from app.core.rate_limit import limit_auth_attempts
from app.core.security import create_access_token
from app.database.session import get_db
from app.schemas.auth import TokenResponse
from app.schemas.number_auth import (
    NumberAccount,
    NumberClaim,
    NumberSignin,
    NumberSignup,
    OtpChallengeOut,
    OtpRequest,
    OtpVerified,
    OtpVerify,
)
from app.services import number_auth_service as svc
from app.core.config import get_settings

router = APIRouter(prefix="/auth/number", tags=["auth-number"], dependencies=[Depends(limit_auth_attempts)])


def _err(code: int, error: str, message: str, **headers) -> HTTPException:
    return HTTPException(code, detail={"code": error, "message": message}, headers=headers or None)


_REGISTERED = _err(status.HTTP_409_CONFLICT, "NUMBER_REGISTERED", "This number already has a FacePay account. Sign in instead.")
_BAD_CODE = _err(status.HTTP_400_BAD_REQUEST, "OTP_INVALID", "That code is not right, or it has expired. Ask for a new code.")
_BAD_SIGNIN = _err(status.HTTP_401_UNAUTHORIZED, "BAD_CREDENTIALS", "Wrong mobile number or passcode.", **{"WWW-Authenticate": "Bearer"})


def _token(account, role: str) -> TokenResponse:
    token, expires_in = create_access_token(account.id, role)
    return TokenResponse(access_token=token, expires_in=expires_in, role=role)


@router.post("/otp", response_model=OtpChallengeOut)
def request_otp(data: OtpRequest, db: Session = Depends(get_db)):
    svc.purge_old(db)
    try:
        row, code = svc.issue_otp(db, data.mobile, data.purpose)
    except svc.NumberAlreadyRegistered:
        raise _REGISTERED from None
    except svc.OtpNotAllowed as exc:
        raise _err(exc.status_code, "OTP_UNAVAILABLE", exc.message) from None
    settings = get_settings()
    return OtpChallengeOut(
        challenge_id=row.challenge_id,
        mobile_masked=mobile_rules.mask(data.mobile),
        expires_in=settings.otp_ttl_seconds,
        resend_in=svc.RESEND_SECONDS,
        demo=True,
        demo_code=code,  # issue_otp refuses to run unless demo mode is on, so reaching here means this is a labelled demo
    )


@router.post("/verify", response_model=OtpVerified)
def verify_otp(data: OtpVerify, db: Session = Depends(get_db)):
    try:
        svc.verify_otp(db, data.challenge_id, data.code)
    except svc.OtpInvalid:
        raise _BAD_CODE from None
    return OtpVerified()


@router.post("/signup", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def sign_up(data: NumberSignup, db: Session = Depends(get_db)):
    if data.account_type == "merchant" and not data.business_name:
        raise _err(status.HTTP_422_UNPROCESSABLE_ENTITY, "BUSINESS_NAME_REQUIRED", "Enter your shop or business name.")
    try:
        account, role = svc.sign_up(db, data)
    except svc.NotAgreed:
        raise _err(status.HTTP_400_BAD_REQUEST, "NOT_AGREED", "Agree to continue.") from None
    except svc.OtpInvalid:
        raise _BAD_CODE from None
    except svc.NumberAlreadyRegistered:
        raise _REGISTERED from None
    return _token(account, role)


@router.post("/signin", response_model=TokenResponse)
def sign_in(data: NumberSignin, db: Session = Depends(get_db)):
    try:
        account, role = svc.sign_in(db, data.mobile, data.passcode)
    except svc.SigninLocked as exc:
        raise _err(
            status.HTTP_429_TOO_MANY_REQUESTS, "SIGNIN_LOCKED",
            f"Too many wrong passcodes. Try again in {exc.minutes} minute{'s' if exc.minutes != 1 else ''}.",
            **{"Retry-After": str(exc.minutes * 60)},
        ) from None
    except svc.InvalidCredentials:
        raise _BAD_SIGNIN from None
    except svc.AccountDisabled:
        raise _err(status.HTTP_403_FORBIDDEN, "ACCOUNT_DISABLED", "Account is disabled") from None
    return _token(account, role)


@router.post("/claim", response_model=NumberAccount)
def claim_number(data: NumberClaim, who=Depends(get_customer_or_merchant), db: Session = Depends(get_db)):
    """An account made with an email adds a mobile number (verified with a demo code) and a passcode."""
    _kind, account = who
    try:
        svc.claim_number(db, account, data.challenge_id, data.passcode)
    except svc.OtpInvalid:
        raise _BAD_CODE from None
    except svc.NumberAlreadyRegistered:
        raise _err(status.HTTP_409_CONFLICT, "NUMBER_REGISTERED", "This account already has a number, or that number is already in use.") from None
    return NumberAccount(mobile=account.mobile, mobile_masked=mobile_rules.mask(account.mobile))
