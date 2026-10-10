"""Camera-frame-like scenes for the authentication tests: a synthetic 'face' pasted onto a flat
background, so its position is exactly known. BackgroundBoxDetector finds faces by their pixels
differing from the background, standing in for the Haar detector (which needs real photographs)."""

import cv2
import numpy as np

from app.ml import config as cfg
from app.ml.preprocessing import Box
from tests.synthetic_faces import png_bytes, sample_image

BG = 7
W, H = 400, 240
FACE = 96


class BackgroundBoxDetector:
    def detect(self, gray):
        mask = (gray != BG).astype(np.uint8)
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        return [Box(int(x), int(y), int(w), int(h)) for x, y, w, h, a in stats[1:] if a >= 400]


def scene(identity: int, variation: int, x: int = 150, y: int = 70, extra=None, size: int = FACE) -> bytes:
    """PNG of one face with its top-left at (x, y); `extra` = [(identity, variation, x, y, size)] more faces."""
    img = np.full((H, W), BG, np.uint8)
    face = sample_image(identity, variation)
    if size != FACE:
        face = cv2.resize(face, (size, size))
    img[y : y + size, x : x + size] = face
    for ident, var, ex, ey, esize in extra or []:
        f = cv2.resize(sample_image(ident, var), (esize, esize))
        img[ey : ey + esize, ex : ex + esize] = f
    return png_bytes(img)


def empty_scene() -> bytes:
    return png_bytes(np.full((H, W), BG, np.uint8))


def blurry_scene(identity: int, variation: int, x: int = 150) -> bytes:
    img = np.full((H, W), BG, np.uint8)
    img[70 : 70 + FACE, x : x + FACE] = sample_image(identity, variation)
    return png_bytes(cv2.GaussianBlur(img, (0, 0), 7))  # blur the whole frame, edges included


def sequence(identity: int, challenge: str, moves: list[float], base_x: int = 150, start_var: int = 200, extra_at=None, **kw) -> list[bytes]:
    """Frames for an attempt. `moves` = signed movement of each non-baseline frame as a fraction of the face
    width, positive = TOWARD the requested side (for turn_right the face moves to smaller x, see liveness.py).
    The stationary baseline frames come first."""
    sign = -1 if challenge == "turn_right" else +1
    xs = [base_x] * cfg.AUTH_BASELINE_FRAMES + [round(base_x + sign * m * FACE) for m in moves]
    extra_at = extra_at or {}  # {frame index: [(identity, variation, x, y, size)]}: more faces in those frames only
    return [scene(identity, start_var + i, x=x, extra=extra_at.get(i), **kw) for i, x in enumerate(xs)]


GOOD_TURN = [0.04, 0.10, 0.16, 0.18, 0.18]
