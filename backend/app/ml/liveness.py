"""Challenge-response liveness: "turn your head to your right/left".

What is measured
----------------
For every frame we detect faces and keep the horizontal centre of the single face box,
normalised by the box width. The user first looks straight at the camera (baseline frames),
then performs the requested turn. The challenge passes if the face moves sideways, in the
requested direction, by at least LATERAL_THRESHOLD baseline-box-widths and never moves that
far the other way.

Direction convention: the camera image is NOT mirrored. The user's right side appears on the
image's left, so "turn right" means the face centre moves towards smaller x.

What this is NOT
----------------
This is a lightweight prototype check, not production anti-spoofing. It defeats a static
photograph and a pre-recorded clip that does not follow the (random, single-use) challenge.
It does NOT defeat: a photo or screen that is moved sideways by hand, a video/deepfake that
follows the challenge, a 3D mask, or an attacker who simply turns their own head while a
photo of the victim is shown for the baseline frames. A head turn is not distinguished from a
sideways body movement. Thresholds come from measured detector jitter plus a geometry
estimate, and have not been validated on real webcam turns.
"""

from dataclasses import dataclass

from app.ml import config as cfg
from app.ml.preprocessing import Box, FaceDetector

# Multiply the raw image-space dx by this to get movement "towards" the requested side.
_TOWARD_SIGN = {"turn_right": -1.0, "turn_left": +1.0}

PASSED = "PASSED"
FAILED = "FAILED"
NOT_EVALUATED = "NOT_EVALUATED"


@dataclass(frozen=True)
class FrameObservation:
    faces: int  # faces that count (>= AUTH_SECOND_FACE_RATIO of the largest)
    center_x: float | None  # of the largest face, pixels
    width: float | None


@dataclass(frozen=True)
class LivenessVerdict:
    passed: bool
    detail: str
    toward: float | None = None  # peak movement in the requested direction (box widths)
    away: float | None = None  # peak movement in the opposite direction

    @property
    def result(self) -> str:
        return PASSED if self.passed else FAILED


def observe_boxes(boxes: list[Box], second_face_ratio: float = cfg.AUTH_SECOND_FACE_RATIO) -> FrameObservation:
    if not boxes:
        return FrameObservation(0, None, None)
    ordered = sorted(boxes, key=lambda b: b.area, reverse=True)
    faces = sum(1 for b in ordered if b.area >= second_face_ratio * ordered[0].area)
    top = ordered[0]
    return FrameObservation(faces, top.x + top.w / 2, float(top.w))


def observe(gray, detector: FaceDetector) -> FrameObservation:
    """Detect faces in one decoded grayscale frame (downscaled like the enrolment path)."""
    import cv2  # local import keeps this module's pure functions importable without OpenCV

    h, w = gray.shape
    scale = cfg.DETECTION_MAX_SIDE / max(h, w)
    if scale < 1:
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return observe_boxes(detector.detect(gray))


def evaluate(challenge: str, observations: list[FrameObservation]) -> LivenessVerdict:
    """Decide whether the frame sequence satisfies the challenge. Pure; machine-readable `detail`."""
    sign = _TOWARD_SIGN[challenge]
    n = len(observations)
    base_n = cfg.AUTH_BASELINE_FRAMES
    if n < cfg.AUTH_MIN_FRAMES:
        return LivenessVerdict(False, "TOO_FEW_FRAMES")
    usable = [o for o in observations if o.faces == 1]
    if len(usable) < cfg.MIN_USABLE_FRAME_FRACTION * n or any(o.faces != 1 for o in observations[:base_n]):
        return LivenessVerdict(False, "FACE_LOST")

    b0, b1 = observations[:base_n][0], observations[:base_n][-1]
    base_w = sum(o.width for o in observations[:base_n]) / base_n
    base_cx = sum(o.center_x for o in observations[:base_n]) / base_n
    if abs(b0.center_x - b1.center_x) / base_w > cfg.BASELINE_MAX_DRIFT:
        return LivenessVerdict(False, "UNSTABLE_BASELINE")

    moves = [sign * (o.center_x - base_cx) / base_w for o in observations[base_n:] if o.faces == 1]
    toward = max(moves, default=0.0)
    away = max((-m for m in moves), default=0.0)
    t = cfg.LATERAL_THRESHOLD
    if toward >= t and away >= t:
        return LivenessVerdict(False, "AMBIGUOUS_MOTION", toward, away)
    if toward >= t:
        return LivenessVerdict(True, "COMPLETED", toward, away)
    if away >= t:
        return LivenessVerdict(False, "WRONG_DIRECTION", toward, away)
    if toward >= 0.4 * t:
        return LivenessVerdict(False, "INCOMPLETE_MOVEMENT", toward, away)
    return LivenessVerdict(False, "NO_MOVEMENT", toward, away)
