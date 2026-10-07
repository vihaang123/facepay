from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.rate_limit import limit_auth_attempts
from app.core.security import create_access_token
from app.database.session import get_db
from app.schemas.auth import (
    CustomerRegister,
    LoginRequest,
    MerchantOut,
    MerchantRegister,
    TokenResponse,
    UserOut,
)
from app.services import auth_service as svc

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(limit_auth_attempts)])

_BAD_CREDENTIALS = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Incorrect email or password",
    headers={"WWW-Authenticate": "Bearer"},
)
_DUPLICATE = HTTPException(
    status_code=status.HTTP_409_CONFLICT,
    detail="An account with this email already exists",
)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register_customer(data: CustomerRegister, db: Session = Depends(get_db)):
    try:
        return svc.register_customer(db, data)
    except svc.EmailAlreadyRegistered:
        raise _DUPLICATE from None


@router.post("/login", response_model=TokenResponse)
def login_customer(data: LoginRequest, db: Session = Depends(get_db)):
    try:
        user = svc.authenticate_customer(db, data.email, data.password)
    except svc.InvalidCredentials:
        raise _BAD_CREDENTIALS from None
    except svc.AccountDisabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Account is disabled") from None
    token, expires_in = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token, expires_in=expires_in, role=user.role)


@router.post(
    "/merchant/register", response_model=MerchantOut, status_code=status.HTTP_201_CREATED
)
def register_merchant(data: MerchantRegister, db: Session = Depends(get_db)):
    try:
        return svc.register_merchant(db, data)
    except svc.EmailAlreadyRegistered:
        raise _DUPLICATE from None


@router.post("/merchant/login", response_model=TokenResponse)
def login_merchant(data: LoginRequest, db: Session = Depends(get_db)):
    try:
        merchant = svc.authenticate_merchant(db, data.email, data.password)
    except svc.InvalidCredentials:
        raise _BAD_CREDENTIALS from None
    token, expires_in = create_access_token(merchant.id, "merchant")
    return TokenResponse(access_token=token, expires_in=expires_in, role="merchant")
