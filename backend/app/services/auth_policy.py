"""The authentication decision, kept separate from the classifier on purpose.

The classifier only says "this face looks most like user X". Authentication additionally needs
the account to be usable, a model to exist, a clean single-face capture, a passed liveness
challenge, the right identity, enough classifier support and a face close enough to the user's
own stored profile. `decide` is a pure function so the whole policy can be tested exhaustively.

Order matters: the first failing check supplies the reason. Reasons never name another user.
"""

from dataclasses import dataclass

from app.ml import config as cfg

AUTHENTICATED = "AUTHENTICATED"
REJECTED = "REJECTED"

REASONS = (
    "ACCOUNT_DISABLED",
    "CHALLENGE_INVALID",
    "CHALLENGE_EXPIRED",
    "MODEL_UNAVAILABLE",
    "NOT_ENROLLED",
    # Why recognition could not run (the face itself was never judged). See face_service.MODEL_ISSUES.
    "ENROLLMENT_INSUFFICIENT",
    "INSUFFICIENT_IDENTITIES",
    "MODEL_NOT_TRAINED",
    "MODEL_NOT_FOUND",
    "MODEL_STALE",
    "MODEL_VERSION_INCOMPATIBLE",
    "MODEL_LOAD_FAILED",
    "BIOMETRIC_DECRYPTION_FAILED",
    "INVALID_IMAGE",
    "FACE_NOT_DETECTED",
    "MULTIPLE_FACES_DETECTED",
    "FACE_TOO_SMALL",
    "POOR_IMAGE_QUALITY",
    "LIVENESS_FAILED",
    "IDENTITY_MISMATCH",
    "LOW_CONFIDENCE",
    "DISTANCE_TOO_HIGH",
)

# FaceImageError codes (app.ml.preprocessing) -> (reason, detail)
IMAGE_ERROR_REASON = {
    "INVALID_IMAGE": ("INVALID_IMAGE", None),
    "IMAGE_TOO_LARGE": ("INVALID_IMAGE", "IMAGE_TOO_LARGE"),
    "NO_FACE": ("FACE_NOT_DETECTED", None),
    "MULTIPLE_FACES": ("MULTIPLE_FACES_DETECTED", None),
    "FACE_TOO_SMALL": ("FACE_TOO_SMALL", None),
    "TOO_BLURRY": ("POOR_IMAGE_QUALITY", "TOO_BLURRY"),
    "TOO_DARK": ("POOR_IMAGE_QUALITY", "TOO_DARK"),
    "TOO_BRIGHT": ("POOR_IMAGE_QUALITY", "TOO_BRIGHT"),
}


@dataclass(frozen=True)
class FrameIdentity:
    """Model output for one baseline frame."""

    predicted_is_user: bool
    confidence: float
    distance: float


@dataclass(frozen=True)
class Evidence:
    account_active: bool = True
    challenge: str = "OK"  # OK | INVALID | EXPIRED
    model_available: bool = True
    enrolled: bool = True
    model_issue: str | None = None  # a specific reason from face_service.MODEL_ISSUES; takes precedence over the two flags
    image_reason: tuple[str, str | None] | None = None  # (reason, detail) from IMAGE_ERROR_REASON
    liveness_passed: bool | None = None
    liveness_detail: str | None = None
    frames: tuple[FrameIdentity, ...] = ()
    distance_threshold: float | None = None


@dataclass(frozen=True)
class Decision:
    authenticated: bool
    reason: str | None = None
    detail: str | None = None

    @property
    def result(self) -> str:
        return AUTHENTICATED if self.authenticated else REJECTED


def _no(reason: str, detail: str | None = None) -> Decision:
    return Decision(False, reason, detail)


def decide(e: Evidence, min_confidence: float | None = None) -> Decision:
    min_confidence = cfg.AUTH_MIN_CONFIDENCE if min_confidence is None else min_confidence
    if not e.account_active:
        return _no("ACCOUNT_DISABLED")
    if e.challenge == "INVALID":
        return _no("CHALLENGE_INVALID")
    if e.challenge == "EXPIRED":
        return _no("CHALLENGE_EXPIRED")
    if e.model_issue is not None:
        return _no(e.model_issue)
    if not e.model_available:
        return _no("MODEL_UNAVAILABLE")
    if not e.enrolled:
        return _no("NOT_ENROLLED")
    if e.image_reason is not None:
        return _no(*e.image_reason)
    if e.liveness_passed is not True:
        return _no("LIVENESS_FAILED", e.liveness_detail)
    # Every baseline frame must independently pass identity, support and distance: one lucky frame is not enough.
    if not e.frames or e.distance_threshold is None:
        return _no("IDENTITY_MISMATCH")
    if not all(f.predicted_is_user for f in e.frames):
        return _no("IDENTITY_MISMATCH")
    if any(f.confidence < min_confidence for f in e.frames):
        return _no("LOW_CONFIDENCE")
    if any(f.distance > e.distance_threshold for f in e.frames):
        return _no("DISTANCE_TOO_HIGH")
    return Decision(True)


# Reasons that mean "recognition could not run", as opposed to a decision about the face. Used for stages, logs and UI.
MODEL_NOT_READY_REASONS = frozenset({
    "MODEL_UNAVAILABLE", "NOT_ENROLLED", "ENROLLMENT_INSUFFICIENT", "INSUFFICIENT_IDENTITIES", "MODEL_NOT_TRAINED",
    "MODEL_NOT_FOUND", "MODEL_STALE", "MODEL_VERSION_INCOMPATIBLE", "MODEL_LOAD_FAILED", "BIOMETRIC_DECRYPTION_FAILED",
})
