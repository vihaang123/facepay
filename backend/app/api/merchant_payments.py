"""Merchant side: create and watch payment sessions, see own transactions and a simple summary."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_merchant
from app.database.session import get_db
from app.models import Merchant
from app.api.payments import TX_SORT, TX_STATUS
from app.schemas.payments import (
    DisplayRequest,
    FaceSessionCreate,
    MerchantSecuritySummary,
    MerchantSessionOut,
    MerchantSummary,
    MerchantTransactionOut,
    ReceiptOut,
    ReconciliationOut,
    SessionCreate,
)
from app.services import face_lookup_service
from app.services import payment_service as svc

router = APIRouter(prefix="/merchant", tags=["merchant-payments"])

_STATUS = "^(CREATED|AUTHENTICATED|PAID|FAILED|EXPIRED|CANCELLED)$"


@router.post("/payment-sessions", response_model=MerchantSessionOut, status_code=201)
def create_session(data: SessionCreate, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    ps = svc.create_session(
        db, merchant, amount=data.amount, order_reference=data.order_reference,
        description=data.description, expires_in_minutes=data.expires_in_minutes, discoverable=data.discoverable,
    )
    return svc.merchant_session(db, merchant, ps.session_id)


@router.post("/payment-sessions/by-face", response_model=MerchantSessionOut, status_code=201)
def create_session_for_found_customer(data: FaceSessionCreate, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    """A request to the one customer this shop just found by face (the single-use ticket from POST /face-lookup). The customer
    gets it as a pop-up and approves it with their own face check; nobody else can open it."""
    payer = face_lookup_service.redeem(db, data.lookup_token, requester_merchant=merchant)  # spent only if the request is saved
    ps = svc.create_session(
        db, merchant, amount=data.amount, order_reference=data.order_reference, description=data.description,
        expires_in_minutes=data.expires_in_minutes, payer=payer, purpose=data.purpose,
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


@router.post("/payment-sessions/{session_id}/display", response_model=MerchantSessionOut)
def display_session(session_id: str, data: DisplayRequest, merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    """Show or hide an open request in the simulated nearby list."""
    return svc.set_display(db, merchant, session_id, data.discoverable)


@router.get("/reconciliation", response_model=ReconciliationOut)
def reconciliation(merchant: Merchant = Depends(get_current_merchant), db: Session = Depends(get_db)):
    """Payment requests against the backend transactions that settled them (the only proof of payment)."""
    return svc.reconciliation(db, merchant)


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
