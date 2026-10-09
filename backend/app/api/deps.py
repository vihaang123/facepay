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


def get_customer_any_status(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """The signed-in customer even if the account was disabled after the token was issued.
    Only for endpoints that must record and report ACCOUNT_DISABLED themselves (face authentication)."""
    claims = _claims(credentials)
    if claims["role"] not in ("customer", "admin"):
        # A merchant token must never open customer routes.
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Customer access required")
    user = db.get(User, _subject_id(claims))
    if user is None:
        raise _UNAUTHORIZED
    return user


def get_current_customer(user: User = Depends(get_customer_any_status)) -> User:
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


def get_current_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Administrators only. Neither a customer nor a merchant account is ever promoted by anything in the request:
    the role must be 'admin' in the signed token AND in the database right now (so a demotion takes effect at once).
    Admin accounts are created out of band with `python -m app.cli create-admin`; there is no endpoint for it."""
    claims = _claims(credentials)
    if claims["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Administrator access required")
    user = db.get(User, _subject_id(claims))
    if user is None:
        raise _UNAUTHORIZED
    if user.role != "admin" or user.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Administrator access required")
    return user
