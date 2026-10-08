import base64
import binascii
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.ml import config as cfg


class ChallengeOut(BaseModel):
    challenge_id: str
    challenge: str
    instruction: str
    expires_in_seconds: int
    baseline_frames: int
    min_frames: int
    max_frames: int


class VerifyRequest(BaseModel):
    challenge_id: str = Field(min_length=16, max_length=64)
    # Chronological JPEG/PNG frames (base64): the first `baseline_frames` look straight at the camera,
    # the rest show the requested head turn.
    frames: list[str] = Field(min_length=cfg.AUTH_MIN_FRAMES, max_length=cfg.AUTH_MAX_FRAMES)

    @field_validator("frames")
    @classmethod
    def _frames_are_base64(cls, frames: list[str]) -> list[str]:
        for f in frames:
            if not 16 <= len(f) <= 1_000_000:
                raise ValueError("Each frame must be between 16 and 1,000,000 base64 characters")
            s = f.partition(",")[2] if f.startswith("data:") else f
            try:
                base64.b64decode(s, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("Frames must be valid base64") from None
        return frames


class StageOut(BaseModel):
    stage: str  # FACE_DETECTION | LIVENESS | IDENTITY
    status: str  # PASSED | FAILED | SKIPPED


class IdentityOut(BaseModel):
    verified: bool
    confidence: float  # classifier score for YOUR class (minimum over the frames used), not a calibrated probability
    distance: float  # distance to your stored profile (maximum over the frames used)
    distance_threshold: float
    frames_evaluated: int
    name: str | None = None  # your own name, only when authenticated


class AuthResult(BaseModel):
    result: str  # AUTHENTICATED | REJECTED
    reason: str | None
    detail: str | None
    authentication_id: int
    stages: list[StageOut]
    liveness: str  # PASSED | FAILED | NOT_EVALUATED
    challenge: str | None
    identity: IdentityOut | None
    model_version: str | None


class AttemptOut(BaseModel):
    id: int
    timestamp: datetime
    result: str
    failure_reason: str | None
    failure_detail: str | None
    confidence: float | None
    distance: float | None
    liveness_result: str | None
    challenge: str | None
    model_version: str | None
    payment_session_ref: str | None = None
    transaction_ref: str | None = None

    model_config = {"from_attributes": True}
