"""Customer side of FacePay payments: checkout, authenticate for a session, confirm, history, receipts."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer, get_customer_any_status
from app.api.face_auth import face_auth_limiter
from app.api.faces import get_detector
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.ml.preprocessing import FaceDetector
from app.models import User
from app.schemas.face_auth import ChallengeOut
from app.schemas.payments import (
    CheckoutOut,
    ConfirmRequest,
    CustomerSummary,
    CustomerTransactionOut,
    PaymentAuthResult,
    PaymentVerifyRequest,
    ReceiptOut,
)
from app.services import payment_service as svc

_s = get_settings()
payment_limiter = RateLimiter(_s.payment_rate_limit_per_minute, enabled=_s.rate_limit_enabled)

TX_STATUS = "^(SUCCESS|FAILED|PENDING)$"
TX_SORT = "^(newest|oldest|amount_desc|amount_asc)$"

router = APIRouter(prefix="/payments", tags=["payments"])


def _too_many(limiter: RateLimiter, message: str) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"code": "RATE_LIMITED", "message": message},
        headers={"Retry-After": str(limiter.window_seconds)},
    )


def _auth_limit(request: Request, user: User = Depends(get_customer_any_status)) -> None:
    if not face_auth_limiter.allow(f"face-auth:user{user.id}"):  # same budget as /face-auth
        raise _too_many(face_auth_limiter, "Too many authentication attempts. Please wait a minute.")


def _pay_limit(request: Request, user: User = Depends(get_customer_any_status)) -> None:
    if not payment_limiter.allow(f"payments:user{user.id}"):
        raise _too_many(payment_limiter, "Too many requests. Please wait a minute.")


@router.get("/sessions/{session_id}", response_model=CheckoutOut, dependencies=[Depends(_pay_limit)])
def checkout(session_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.checkout_view(db, user, session_id)


@router.post("/sessions/{session_id}/authenticate/start", response_model=ChallengeOut, dependencies=[Depends(_auth_limit)])
def start_authentication(session_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    """Step 1 of FacePay authentication for this payment: a single-use liveness challenge."""
    return svc.start_authentication(db, user, session_id)


@router.post("/sessions/{session_id}/authenticate", response_model=PaymentAuthResult, dependencies=[Depends(_auth_limit)])
def complete_authentication(
    session_id: str,
    data: PaymentVerifyRequest,
    user: User = Depends(get_customer_any_status),
    db: Session = Depends(get_db),
    detector: FaceDetector = Depends(get_detector),
):
    """Step 2: face + liveness decision (Phase 4). Only an AUTHENTICATED decision made by the backend here
    issues a single-use authorization; there is no client-supplied 'authenticated' flag anywhere."""
    return svc.authenticate_for_payment(db, user, session_id, data.challenge_id, data.frames, detector)


@router.post("/sessions/{session_id}/confirm", response_model=ReceiptOut, dependencies=[Depends(_pay_limit)])
def confirm(session_id: str, data: ConfirmRequest, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.confirm_payment(
        db,
        user,
        session_id,
        data.authorization_token,
        expected_amount=data.expected_amount,
        expected_merchant=data.expected_merchant,
        expected_order_reference=data.expected_order_reference,
        expected_recipient=data.expected_recipient,
        pin=data.pin,
    )


@router.get("/transactions", response_model=list[CustomerTransactionOut])
def my_transactions(
    limit: int = Query(20, ge=1, le=101),  # 101 lets a client ask for a page plus one row to know if there is a next page
    offset: int = Query(0, ge=0, le=100_000),
    status: str | None = Query(None, pattern=TX_STATUS),
    q: str | None = Query(None, max_length=60),
    sort: str = Query("newest", pattern=TX_SORT),
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    return svc.customer_transactions(db, user, limit=limit, offset=offset, status=status, q=(q or "").strip() or None, sort=sort)


@router.get("/summary", response_model=CustomerSummary)
def my_summary(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.customer_summary(db, user)


@router.get("/transactions/{transaction_id}", response_model=ReceiptOut)
def my_receipt(transaction_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.customer_receipt(db, user, transaction_id)
