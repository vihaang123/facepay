from datetime import datetime

from pydantic import BaseModel, Field


class SampleUpload(BaseModel):
    # base64 of a JPEG/PNG (a data: URL prefix is accepted). ~1.5 MB of image -> ~2 MB of text.
    image_base64: str = Field(min_length=16, max_length=2_100_000)
    pose: str = Field(min_length=1, max_length=20)


class RecognizeRequest(BaseModel):
    image_base64: str = Field(min_length=16, max_length=2_100_000)


class PoseProgress(BaseModel):
    pose: str
    instruction: str
    count: int
    target: int


class GuidedPose(BaseModel):
    pose: str
    instruction: str
    count: int
    target: int


class GuidedProgress(BaseModel):
    """Where the guided (automatic) enrolment flow is. Derived from the stored samples, so it resumes after a reload."""

    sequence: list[GuidedPose]
    captured: int
    required: int
    next_pose: str | None
    complete: bool


class EnrollmentStatus(BaseModel):
    guided: GuidedProgress
    poses: list[PoseProgress]
    total_samples: int
    distinct_poses: int
    max_samples: int
    min_samples_to_train: int
    min_poses_to_train: int
    eligible: bool
    has_profile: bool


class QualityOut(BaseModel):
    sharpness: float
    brightness: float
    face_size: int
    aligned: bool


class Progress(BaseModel):
    captured: int
    required: int


class SampleResult(BaseModel):
    accepted: bool = True
    quality: QualityOut
    next_pose: str | None
    progress: Progress
    enrollment: EnrollmentStatus


class FrameGeometry(BaseModel):
    """Where the largest face is, as fractions of the frame (0..1). No pixels, no features."""

    cx: float
    cy: float
    width: float
    height: float


class AssessRequest(BaseModel):
    image_base64: str = Field(min_length=16, max_length=2_100_000)


class AssessResult(BaseModel):
    """Live feedback for the guided capture. Nothing is stored. Acceptance is decided only by POST /faces/samples."""

    state: str  # OK | NO_FACE | MULTIPLE_FACES | FACE_TOO_SMALL | TOO_DARK | TOO_BRIGHT | TOO_BLURRY | INVALID_IMAGE
    faces: int
    face: FrameGeometry | None

class ModelSummary(BaseModel):
    """What a customer may know about the recognition model: whether it is ready and includes them. Classifier
    settings, validation results and scores are administrator-only (see /admin/ml)."""

    version: str
    trained_at: datetime
    includes_you: bool
    stale: bool  # enrolment data changed since this model was trained


class ModelStatus(BaseModel):
    model: ModelSummary | None


class RecognitionResult(BaseModel):
    """A test recognition for the signed-in customer. No scores, distances or thresholds: those are internal."""

    matched: bool
    reason: str  # MATCH | WRONG_IDENTITY | TOO_FAR_FROM_PROFILE
    predicted_is_you: bool
    model_version: str
    quality: QualityOut


class CountCheck(BaseModel):
    have: int
    need: int


class ReadinessChecks(BaseModel):
    samples: CountCheck
    poses: CountCheck
    people_with_finished_setup: dict[str, bool]  # {"enough": bool}; other people are never counted out loud or named
    model_active: bool
    you_are_in_model: bool


class Readiness(BaseModel):
    """Can this customer be recognised right now? If not, a safe code, a sentence, and what to do about it. Says nothing
    about the person's face: no decision was made about it."""

    ready: bool
    code: str | None
    message: str
    next_action: str | None  # ENROLL | TRAIN | WAIT_FOR_SECOND_PERSON | CONTACT_ADMIN
    stale: bool
    model_version: str | None
    checks: ReadinessChecks
