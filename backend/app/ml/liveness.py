"""Challenge-response liveness: "turn your head to your right/left".

What is measured
----------------
For every frame we detect the DISTINCT faces (duplicate boxes on one face are one face) and keep the
horizontal centre of the single face box, normalised by the box width. The user first looks straight
at the camera (baseline frames), then performs the requested turn. The challenge passes if the face
moves sideways, in the requested direction, by at least LATERAL_THRESHOLD baseline-box-widths in at
least two usable frames (one noisy frame cannot pass or fail the challenge), and does not move that
far the other way.

Frame-level noise is absorbed, not ignored: one missed baseline frame is tolerated (the baseline is the
median of the usable ones), a face lost for a short run during the turn is tolerated (a turned head is
often no longer a frontal face), and a spurious second box in an isolated frame does not count as a
second person. A second face that persists across the sequence still rejects the attempt.

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
from math import ceil
from statistics import median

from app.ml import config as cfg
from app.ml.preprocessing import Box, FaceDetector, distinct_faces

# Multiply the raw image-space dx by this to get movement "towards" the requested side.
_TOWARD_SIGN = {"turn_right": -1.0, "turn_left": +1.0}

PASSED = "PASSED"
FAILED = "FAILED"
NOT_EVALUATED = "NOT_EVALUATED"


@dataclass(frozen=True)
class FrameObservation:
    faces: int  # distinct faces that count (>= AUTH_SECOND_FACE_RATIO of the largest)
    center_x: float | None  # of the largest face, pixels
    width: float | None


@dataclass(frozen=True)
class LivenessVerdict:
    passed: bool
    detail: str
    toward: float | None = None  # movement in the requested direction reached in at least two frames (box widths)
    away: float | None = None  # same, in the opposite direction
    trace: str = ""  # frame-by-frame summary for restricted server logs (counts only; no images, no coordinates)

    @property
    def result(self) -> str:
        return PASSED if self.passed else FAILED


def observe_boxes(boxes: list[Box], second_face_ratio: float = cfg.AUTH_SECOND_FACE_RATIO) -> FrameObservation:
    ordered = distinct_faces(boxes)
    if not ordered:
        return FrameObservation(0, None, None)
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


def multiple_faces(observations: list[FrameObservation]) -> bool:
    """A second person is in view for a meaningful share of the sequence. One or two frames with a stray second box are
    detector noise (measured: see docs/final/detection-evidence.md); a person standing in view is there in nearly every frame."""
    multi = sum(1 for o in observations if o.faces > 1)
    return multi >= max(cfg.MULTI_FACE_MIN_FRAMES, ceil(cfg.MULTI_FACE_FRAME_FRACTION * len(observations)))


def _second_highest(values: list[float]) -> float:
    """The level reached in at least two frames. One spike cannot reach it."""
    ordered = sorted(values, reverse=True)
    return ordered[1] if len(ordered) > 1 else 0.0


def _longest_run(flags: list[bool]) -> int:
    best = run = 0
    for f in flags:
        run = run + 1 if f else 0
        best = max(best, run)
    return best


def evaluate(challenge: str, observations: list[FrameObservation]) -> LivenessVerdict:
    """Decide whether the frame sequence satisfies the challenge. Pure; machine-readable `detail`."""
    sign = _TOWARD_SIGN[challenge]
    n = len(observations)
    base_n = cfg.AUTH_BASELINE_FRAMES
    if n < cfg.AUTH_MIN_FRAMES:
        return LivenessVerdict(False, "TOO_FEW_FRAMES")
    baseline, turn = observations[:base_n], observations[base_n:]
    base_ok = [o for o in baseline if o.faces == 1]
    turn_lost = [o.faces != 1 for o in turn]
    turn_ok = [o for o in turn if o.faces == 1]
    lost_run = _longest_run(turn_lost)
    trace = f"frames={n} baseline_usable={len(base_ok)}/{len(baseline)} turn_usable={len(turn_ok)}/{len(turn)} longest_lost_run={lost_run}"

    if len(base_ok) < cfg.BASELINE_MIN_USABLE:
        return LivenessVerdict(False, "FACE_LOST", trace=trace)
    if len(turn_ok) < max(cfg.MIN_USABLE_TURN_FRAMES, ceil(cfg.MIN_USABLE_TURN_FRACTION * len(turn))) or lost_run > cfg.MAX_LOST_RUN:
        return LivenessVerdict(False, "FACE_LOST", trace=trace)

    base_w = median(o.width for o in base_ok)
    base_cx = median(o.center_x for o in base_ok)
    if (max(o.center_x for o in base_ok) - min(o.center_x for o in base_ok)) / base_w > cfg.BASELINE_MAX_DRIFT:
        return LivenessVerdict(False, "UNSTABLE_BASELINE", trace=trace)

    moves = [sign * (o.center_x - base_cx) / base_w for o in turn_ok]
    toward = _second_highest(moves)
    away = _second_highest([-m for m in moves])
    trace += f" toward={toward:.3f} away={away:.3f}"
    t = cfg.LATERAL_THRESHOLD
    if toward >= t and away >= t:
        return LivenessVerdict(False, "AMBIGUOUS_MOTION", toward, away, trace)
    if toward >= t:
        return LivenessVerdict(True, "COMPLETED", toward, away, trace)
    if away >= t:
        return LivenessVerdict(False, "WRONG_DIRECTION", toward, away, trace)
    if toward >= 0.4 * t:
        return LivenessVerdict(False, "INCOMPLETE_MOVEMENT", toward, away, trace)
    return LivenessVerdict(False, "NO_MOVEMENT", toward, away, trace)
