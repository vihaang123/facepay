"""Customer security controls: overview, biometric switch, payment PIN. Face data removal is DELETE /faces/samples."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.models import User
from app.schemas.security import BiometricToggle, PasswordOnly, SecurityOverview, SetPin
from app.services import security_service as sec

_s = get_settings()
security_limiter = RateLimiter(20, enabled=_s.rate_limit_enabled)  # PIN changes verify the password: keep guessing slow


def _limit(request: Request, user: User = Depends(get_current_customer)) -> None:
    if not security_limiter.allow(f"security:user{user.id}"):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "RATE_LIMITED", "message": "Too many requests. Please wait a minute."},
            headers={"Retry-After": str(security_limiter.window_seconds)},
        )


router = APIRouter(prefix="/security", tags=["security"])


@router.get("/overview", response_model=SecurityOverview)
def overview(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return sec.overview(db, user)


@router.put("/biometric", response_model=SecurityOverview, dependencies=[Depends(_limit)])
def set_biometric(data: BiometricToggle, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    """Turning this off blocks face authentication for payments until it is turned back on."""
    if user.biometric_payments_enabled != data.enabled:
        user.biometric_payments_enabled = data.enabled
        sec.record_event(db, user, "BIOMETRIC_ENABLED" if data.enabled else "BIOMETRIC_DISABLED")
        db.commit()
    return sec.overview(db, user)


@router.put("/pin", response_model=SecurityOverview, dependencies=[Depends(_limit)])
def set_pin(data: SetPin, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    sec.set_pin(db, user, data.password, data.new_pin)
    return sec.overview(db, user)


@router.post("/pin/remove", response_model=SecurityOverview, dependencies=[Depends(_limit)])
def remove_pin(data: PasswordOnly, user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    sec.remove_pin(db, user, data.password)
    return sec.overview(db, user)
