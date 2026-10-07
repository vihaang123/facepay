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


class EnrollmentStatus(BaseModel):
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


class SampleResult(BaseModel):
    accepted: bool = True
    quality: QualityOut
    enrollment: EnrollmentStatus


class VariantMetrics(BaseModel):
    accuracy: float
    macro_precision: float
    macro_recall: float
    macro_f1: float
    predict_ms_per_sample: float


class ModelSummary(BaseModel):
    version: str
    trained_at: datetime
    n_users: int
    n_samples: int
    classifier: str
    pca: dict
    lda: dict | None
    validation: str
    comparison: dict[str, VariantMetrics]
    distance_threshold: float
    includes_you: bool
    stale: bool  # enrolment data changed since this model was trained


class ModelStatus(BaseModel):
    model: ModelSummary | None


class RecognitionResult(BaseModel):
    matched: bool
    reason: str  # MATCH | WRONG_IDENTITY | TOO_FAR_FROM_PROFILE
    predicted_is_you: bool
    user_id: int | None  # only set when the prediction is the caller
    confidence: float
    distance_to_you: float | None
    distance_threshold: float | None
    model_version: str
    quality: QualityOut
