"""Customer wallet, FacePay ID, customer-to-customer payments, money requests, QR resolution and history.
Every route is customer-only and every query is scoped to the signed-in customer."""

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer
from app.api.payments import CheckoutOut
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.models import User
from app.schemas.transfers import (
    ActivityCounts,
    ActivityDetail,
    ActivityItem,
    CancelOut,
    ChangeIdRequest,
    ContactOut,
    FacePayProfile,
    QrResolveOut,
    QrResolveRequest,
    RequestCreate,
    RequestOut,
    ResolveOut,
    TransferCreate,
    WalletOut,
)
from app.services import activity_service, facepay_service, ledger_service, request_service, transfer_service

_s = get_settings()
resolve_limiter = RateLimiter(_s.resolve_rate_limit_per_minute, enabled=_s.rate_limit_enabled)
transfer_limiter = RateLimiter(_s.transfer_rate_limit_per_minute, enabled=_s.rate_limit_enabled)
read_limiter = RateLimiter(120, enabled=_s.rate_limit_enabled)

REQUEST_STATUS = "^(PENDING|PAID|DECLINED|CANCELLED|EXPIRED)$"
BOX = "^(incoming|outgoing|all)$"
ACTIVITY_FILTER = "^(" + "|".join(activity_service.FILTERS) + ")$"
_KEY = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=64, pattern=r"^[A-Za-z0-9._\-]+$")


def _too_many(limiter: RateLimiter, message: str) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"code": "RATE_LIMITED", "message": message},
        headers={"Retry-After": str(limiter.window_seconds)},
    )


def _limit(limiter: RateLimiter, name: str, message: str):
    def dep(request: Request, user: User = Depends(get_current_customer)) -> None:
        if not limiter.allow(f"{name}:user{user.id}"):
            raise _too_many(limiter, message)

    return dep


_resolve = _limit(resolve_limiter, "resolve", "Too many lookups. Please wait a minute.")
_create = _limit(transfer_limiter, "transfer", "Too many payments or requests. Please wait a minute.")
_read = _limit(read_limiter, "read", "Too many requests. Please wait a minute.")

router = APIRouter(tags=["transfers"])


# ------------------------------------------------------------------ wallet and FacePay ID


@router.get("/wallet", response_model=WalletOut, dependencies=[Depends(_read)])
def wallet(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    """The simulated balance and the ledger lines behind it. Authoritative: the browser never computes a balance."""
    return ledger_service.wallet(db, user)


@router.get("/facepay/me", response_model=FacePayProfile)
def my_facepay_id(user: User = Depends(get_current_customer)):
    return facepay_service.profile(user)


@router.put("/facepay/me", response_model=FacePayProfile, dependencies=[Depends(_create)])
def change_my_facepay_id(data: ChangeIdRequest, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return facepay_service.profile(facepay_service.change_id(db, user, data.facepay_id))


@router.get("/facepay/resolve", response_model=ResolveOut, dependencies=[Depends(_resolve)])
def resolve(id: str = Query(min_length=1, max_length=60), user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return facepay_service.resolve(db, user, id)


@router.post("/facepay/qr/resolve", response_model=QrResolveOut, dependencies=[Depends(_resolve)])
def resolve_qr(data: QrResolveRequest, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return facepay_service.resolve_qr(db, user, data.payload)


@router.get("/facepay/contacts", response_model=list[ContactOut], dependencies=[Depends(_read)])
def contacts(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return facepay_service.contacts(db, user)


# ------------------------------------------------------------------ send money


@router.post("/transfers", response_model=CheckoutOut, status_code=201, dependencies=[Depends(_create)])
def prepare_transfer(
    data: TransferCreate,
    idempotency_key: str | None = _KEY,
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    """Prepares a payment to a FacePay ID and returns its checkout view. Nothing is debited. The payment is then
    verified and confirmed through /payments/sessions/{session_id}/... exactly like any other payment."""
    return transfer_service.create_intent(
        db, user, recipient_facepay_id=data.recipient_facepay_id, amount=data.amount, note=data.note, idempotency_key=idempotency_key
    )


@router.post("/transfers/{session_id}/cancel", response_model=CancelOut)
def cancel_transfer(session_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return transfer_service.cancel_intent(db, user, session_id)


# ------------------------------------------------------------------ request money


@router.post("/requests", response_model=RequestOut, status_code=201, dependencies=[Depends(_create)])
def create_request(data: RequestCreate, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    """Asks another customer for money. Creates a request only: nobody is debited."""
    return request_service.create(db, user, payer_facepay_id=data.payer_facepay_id, amount=data.amount, note=data.note)


@router.get("/requests", response_model=list[RequestOut], dependencies=[Depends(_read)])
def list_requests(
    box: str = Query("all", pattern=BOX),
    status: str | None = Query(None, pattern=REQUEST_STATUS),
    limit: int = Query(20, ge=1, le=51),
    offset: int = Query(0, ge=0, le=500),
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    return request_service.list_requests(db, user, box=box, status=status, limit=limit, offset=offset)


@router.get("/requests/{request_id}", response_model=RequestOut, dependencies=[Depends(_read)])
def read_request(request_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return request_service.view(db, user, request_id)


@router.post("/requests/{request_id}/pay", response_model=CheckoutOut, status_code=201, dependencies=[Depends(_create)])
def pay_request(
    request_id: str,
    idempotency_key: str | None = _KEY,
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    """The asked customer starts paying. Prepares the payment only; they still verify and confirm it themselves."""
    return transfer_service.pay_request(db, user, request_id, idempotency_key)


@router.post("/requests/{request_id}/decline", response_model=RequestOut)
def decline_request(request_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return request_service.decline(db, user, request_id)


@router.post("/requests/{request_id}/cancel", response_model=RequestOut)
def cancel_request(request_id: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return request_service.cancel(db, user, request_id)


# ------------------------------------------------------------------ history


@router.get("/activity", response_model=list[ActivityItem], dependencies=[Depends(_read)])
def activity(
    filter: str = Query("all", pattern=ACTIVITY_FILTER),
    q: str | None = Query(None, max_length=60),
    limit: int = Query(20, ge=1, le=51),
    offset: int = Query(0, ge=0, le=500),
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
):
    return activity_service.history(db, user, flt=filter, q=(q or "").strip() or None, limit=limit, offset=offset)


@router.get("/activity/counts", response_model=ActivityCounts, dependencies=[Depends(_read)])
def activity_counts(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return activity_service.counts(db, user)


@router.get("/activity/{ref}", response_model=ActivityDetail, dependencies=[Depends(_read)])
def activity_detail(ref: str, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return activity_service.detail(db, user, ref)
