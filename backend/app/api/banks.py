"""Simulated bank connections (the customer's funding sources). Customer-only; every query is scoped to the caller."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.models import User
from app.schemas.banks import BankCatalogOut, BankConnectionOut, BankConnectRequest, BankDisconnectOut
from app.services import bank_service

_s = get_settings()
bank_limiter = RateLimiter(_s.transfer_rate_limit_per_minute, enabled=_s.rate_limit_enabled)

router = APIRouter(prefix="/banks", tags=["banks"])


def _write_limit(request: Request, user: User = Depends(get_current_customer)) -> None:
    if not bank_limiter.allow(f"banks:user{user.id}"):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "RATE_LIMITED", "message": "Too many changes. Please wait a minute."},
            headers={"Retry-After": str(bank_limiter.window_seconds)},
        )


@router.get("/catalog", response_model=BankCatalogOut)
def catalog(user: User = Depends(get_current_customer)):
    """The banks offered in the demo flow. The server owns this list; the client never supplies a bank name."""
    return bank_service.catalog()


@router.get("", response_model=list[BankConnectionOut])
def my_banks(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return bank_service.listing(db, user)


@router.post("", response_model=BankConnectionOut, status_code=201, dependencies=[Depends(_write_limit)])
def connect(data: BankConnectRequest, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    """Creates a simulated connection. No credentials are requested and no bank is contacted."""
    return bank_service.connect(db, user, bank_code=data.bank_code, account_type=data.account_type)


@router.post("/{connection_id}/default", response_model=BankConnectionOut, dependencies=[Depends(_write_limit)])
def make_default(connection_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return bank_service.set_default(db, user, connection_id)


@router.delete("/{connection_id}", response_model=BankDisconnectOut, dependencies=[Depends(_write_limit)])
def disconnect(connection_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return bank_service.disconnect(db, user, connection_id)
