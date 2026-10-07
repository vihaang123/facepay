"""Reusable auth dependencies. Phase 3+ routes depend on these to get the caller."""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.security import TokenError, decode_access_token
from app.database.session import get_db
from app.models import Merchant, User

_bearer = HTTPBearer(auto_error=False)

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def _claims(credentials: HTTPAuthorizationCredentials | None) -> dict:
    if credentials is None:
        raise _UNAUTHORIZED
    try:
        return decode_access_token(credentials.credentials)
    except TokenError:
        raise _UNAUTHORIZED from None


def _subject_id(claims: dict) -> int:
    try:
        return int(claims["sub"])
    except (TypeError, ValueError):
        raise _UNAUTHORIZED from None


def get_current_customer(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    claims = _claims(credentials)
    if claims["role"] not in ("customer", "admin"):
        # A merchant token must never open customer routes.
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Customer access required")
    user = db.get(User, _subject_id(claims))
    if user is None:
        raise _UNAUTHORIZED
    if user.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    return user


def get_current_merchant(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> Merchant:
    claims = _claims(credentials)
    if claims["role"] != "merchant":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Merchant access required")
    merchant = db.get(Merchant, _subject_id(claims))
    if merchant is None:
        raise _UNAUTHORIZED
    return merchant
