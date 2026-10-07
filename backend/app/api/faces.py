from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_customer
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.ml.preprocessing import FaceDetector, FaceImageError, HaarFaceDetector
from app.models import User
from app.schemas.faces import (
    EnrollmentStatus,
    ModelStatus,
    ModelSummary,
    RecognitionResult,
    RecognizeRequest,
    SampleResult,
    SampleUpload,
)
from app.services import face_service as svc

_s = get_settings()
face_limiter = RateLimiter(_s.face_rate_limit_per_minute, enabled=_s.rate_limit_enabled)
train_limiter = RateLimiter(_s.train_rate_limit_per_minute, enabled=_s.rate_limit_enabled)

_detector: FaceDetector | None = None


def get_detector() -> FaceDetector:
    """Overridden in tests (the Haar cascade needs real photographs)."""
    global _detector
    if _detector is None:
        _detector = HaarFaceDetector()
    return _detector


def _limit(limiter: RateLimiter):
    def dep(request: Request, user: User = Depends(get_current_customer)) -> None:
        if not limiter.allow(f"{request.url.path}:user{user.id}"):
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail={"code": "RATE_LIMITED", "message": "Too many requests. Please wait a minute."},
                headers={"Retry-After": str(limiter.window_seconds)},
            )

    return dep


router = APIRouter(prefix="/faces", tags=["faces"])


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, FaceImageError):
        return HTTPException(422, detail={"code": exc.code, "message": exc.message})
    return HTTPException(exc.status, detail={"code": exc.code, "message": exc.message})


@router.get("/enrollment", response_model=EnrollmentStatus)
def enrollment(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.enrollment_status(db, user)


@router.post("/samples", response_model=SampleResult, status_code=201, dependencies=[Depends(_limit(face_limiter))])
def upload_sample(
    data: SampleUpload,
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
    detector: FaceDetector = Depends(get_detector),
):
    try:
        return svc.add_sample(db, user, data.pose, svc.decode_upload(data.image_base64), detector)
    except (FaceImageError, svc.FaceServiceError) as exc:
        raise _http(exc) from None


@router.delete("/samples", status_code=204, dependencies=[Depends(_limit(face_limiter))])
def delete_samples(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    svc.delete_user_face_data(db, user)


@router.post("/train", response_model=ModelSummary, dependencies=[Depends(_limit(train_limiter))])
def train(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    try:
        return svc.train(db, user)
    except svc.FaceServiceError as exc:
        raise _http(exc) from None


@router.get("/model", response_model=ModelStatus)
def model(user: User = Depends(get_current_customer), db: Session = Depends(get_db)):
    return svc.model_summary(db, user)


@router.post("/recognize", response_model=RecognitionResult, dependencies=[Depends(_limit(face_limiter))])
def recognize(
    data: RecognizeRequest,
    user: User = Depends(get_current_customer),
    db: Session = Depends(get_db),
    detector: FaceDetector = Depends(get_detector),
):
    try:
        return svc.recognize(db, user, svc.decode_upload(data.image_base64), detector)
    except (FaceImageError, svc.FaceServiceError) as exc:
        raise _http(exc) from None
