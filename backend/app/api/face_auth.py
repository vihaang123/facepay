from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer, get_customer_any_status
from app.api.faces import get_detector
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.ml.preprocessing import FaceDetector
from app.models import User
from app.schemas.face_auth import AttemptOut, AuthResult, ChallengeOut, VerifyRequest
from app.services import face_auth_service as svc
from app.services import security_service as sec

_s = get_settings()
face_auth_limiter = RateLimiter(_s.face_auth_rate_limit_per_minute, enabled=_s.rate_limit_enabled)

router = APIRouter(prefix="/face-auth", tags=["face-auth"])


def _limit(request: Request, user: User = Depends(get_customer_any_status)) -> None:
    if not face_auth_limiter.allow(f"face-auth:user{user.id}"):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "RATE_LIMITED", "message": "Too many authentication attempts. Please wait a minute."},
            headers={"Retry-After": str(face_auth_limiter.window_seconds)},
        )


@router.post("/challenge", response_model=ChallengeOut, dependencies=[Depends(_limit)])
def challenge(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    sec.require_biometric_allowed(db, user)
    return svc.issue_challenge(db, user)


@router.post("/verify", response_model=AuthResult, dependencies=[Depends(_limit)])
def verify(
    data: VerifyRequest,
    user: User = Depends(get_customer_any_status),
    db: Session = Depends(get_db),
    detector: FaceDetector = Depends(get_detector),
):
    """Always 200 with result AUTHENTICATED or REJECTED (+ machine-readable reason). Malformed input is 422.
    This is the standalone face check: it identifies the customer but authorizes nothing."""
    sec.require_biometric_allowed(db, user)
    return svc.authenticate(db, user, data.challenge_id, data.frames, detector)


@router.get("/attempts", response_model=list[AttemptOut])
def attempts(limit: int = Query(10, ge=1, le=50), user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.list_attempts(db, user, limit)
