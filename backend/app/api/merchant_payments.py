"""Merchant side: create and watch payment sessions, see own transactions and a simple summary."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_merchant
from app.database.session import get_db
from app.models import Merchant
from app.api.payments import TX_SORT, TX_STATUS
from app.schemas.payments import MerchantSecuritySummary, MerchantSessionOut, MerchantSummary, MerchantTransactionOut, ReceiptOut, SessionCreate
from app.services import payment_service as svc

router = APIRouter(prefix="/merchant", tags=["merchant-payments"])

_STATUS = "^(CREATED|AUTHENTICATED|PAID|FAILED|EXPIRED|CANCELLED)$"


@router.post("/payment-sessions", response_model=MerchantSessionOut, status_code=201)
def create_session(data: SessionCreate, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    ps = svc.create_session(
        db, merchant, amount=data.amount, order_reference=data.order_reference,
        description=data.description, expires_in_minutes=data.expires_in_minutes,
    )
    return svc.merchant_session(db, merchant, ps.session_id)


@router.get("/payment-sessions", response_model=list[MerchantSessionOut])
def list_sessions(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: str | None = Query(None, pattern=_STATUS),
    merchant: Merchant = Depends(get_current_merchant),
    db: Session = Depends(get_db),
):
    return svc.merchant_sessions(db, merchant, limit=limit, offset=offset, status=status)


@router.get("/payment-sessions/{session_id}", response_model=MerchantSessionOut)
def read_session(session_id: str, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    return svc.merchant_session(db, merchant, session_id)


@router.post("/payment-sessions/{session_id}/cancel", response_model=MerchantSessionOut)
def cancel_session(session_id: str, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    return svc.cancel_session(db, merchant, session_id)


@router.get("/transactions", response_model=list[MerchantTransactionOut])
def transactions(
    limit: int = Query(20, ge=1, le=101),
    offset: int = Query(0, ge=0, le=100_000),
    status: str | None = Query(None, pattern=TX_STATUS),
    q: str | None = Query(None, max_length=60),
    sort: str = Query("newest", pattern=TX_SORT),
    merchant: Merchant = Depends(get_current_merchant),
    db: Session = Depends(get_db),
):
    return svc.merchant_transactions(db, merchant, limit=limit, offset=offset, status=status, q=(q or "").strip() or None, sort=sort)


@router.get("/transactions/{transaction_id}", response_model=ReceiptOut)
def receipt(transaction_id: str, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    return svc.merchant_receipt(db, merchant, transaction_id)


@router.get("/summary", response_model=MerchantSummary)
def summary(merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    return svc.merchant_summary(db, merchant)


@router.get("/security-summary", response_model=MerchantSecuritySummary)
def security_summary(merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    """Aggregate authentication outcomes for this merchant's own payments. No customer or biometric detail."""
    return svc.merchant_security_summary(db, merchant)
