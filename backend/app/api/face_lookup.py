"""Find a customer by face (customers and shops), so a payment request can be sent to them without typing an ID."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_customer_or_merchant
from app.api.faces import get_detector
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.ml.preprocessing import FaceDetector
from app.schemas.face_lookup import LookupOut, LookupRequest
from app.services import face_lookup_service as svc

_s = get_settings()
lookup_limiter = RateLimiter(_s.face_lookup_rate_limit_per_minute, enabled=_s.rate_limit_enabled)

router = APIRouter(tags=["face-lookup"])


@router.post("/face-lookup", response_model=LookupOut)
def find_by_face(
    data: LookupRequest,
    actor=Depends(get_customer_or_merchant),
    db: Session = Depends(get_db),
    detector: FaceDetector = Depends(get_detector),
):
    """Always 200 with matched true or false (and a reason) for a usable request. Rate limited per requester."""
    kind, who = actor
    if not lookup_limiter.allow(f"lookup:{kind}{who.id}"):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "RATE_LIMITED", "message": "Too many scans. Please wait a minute."},
            headers={"Retry-After": str(lookup_limiter.window_seconds)},
        )
    if kind == "customer":
        return svc.lookup(db, data.frames, detector, requester_user=who)
    return svc.lookup(db, data.frames, detector, requester_merchant=who)
