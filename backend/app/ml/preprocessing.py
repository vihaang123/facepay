"""Image to feature-vector preprocessing.

Pipeline: validate bytes -> decode (grayscale) -> detect face -> level eyes (if found)
-> square crop -> resize -> quality gates -> histogram equalization = stored 64x64 crop.
At training/inference time the stored crop is turned into a vector with `vectorize`
(elliptical mask + z-score). Only the 64x64 crop ever leaves this module; the frame is
discarded.
"""

import math
import struct
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

import cv2
import numpy as np

from app.ml import config as cfg

# ---------------------------------------------------------------- errors


class FaceImageError(Exception):
    """A problem with the submitted image that the user can fix by retaking it."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


INVALID_IMAGE = "INVALID_IMAGE"
IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE"
NO_FACE = "NO_FACE"
MULTIPLE_FACES = "MULTIPLE_FACES"
FACE_TOO_SMALL = "FACE_TOO_SMALL"
TOO_BLURRY = "TOO_BLURRY"
TOO_DARK = "TOO_DARK"
TOO_BRIGHT = "TOO_BRIGHT"

# ---------------------------------------------------------------- bytes -> gray image

_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height) read from the JPEG/PNG header, without decoding pixels."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    if data[:2] == b"\xff\xd8":
        i = 2
        n = len(data)
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker == 0xFF:
                i += 1
                continue
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
            if marker in _SOF_MARKERS:
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return w, h
            i += 2 + seg_len
    return None


def decode_image(data: bytes) -> np.ndarray:
    """Validate and decode an uploaded JPEG/PNG into a grayscale uint8 array."""
    if len(data) > cfg.MAX_IMAGE_BYTES:
        raise FaceImageError(IMAGE_TOO_LARGE, "The image is too large. Please send a smaller photo.")
    dims = image_dimensions(data)
    if dims is None:
        raise FaceImageError(INVALID_IMAGE, "The image could not be read. Send a JPEG or PNG photo.")
    w, h = dims
    if w < 1 or h < 1 or w * h > cfg.MAX_IMAGE_PIXELS:
        raise FaceImageError(IMAGE_TOO_LARGE, "The image dimensions are too large.")
    gray = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FaceImageError(INVALID_IMAGE, "The image could not be read. Send a JPEG or PNG photo.")
    return gray


# ---------------------------------------------------------------- detection


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int

    @property
    def area(self) -> int:
        return self.w * self.h


class FaceDetector(Protocol):
    def detect(self, gray: np.ndarray) -> list[Box]: ...


@lru_cache(maxsize=1)
def _face_cascade() -> "cv2.CascadeClassifier":
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        raise RuntimeError("OpenCV Haar face cascade could not be loaded")
    return cascade


@lru_cache(maxsize=1)
def _eye_cascade() -> "cv2.CascadeClassifier":
    return cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")


class HaarFaceDetector:
    """Classical Viola-Jones detector shipped with OpenCV.

    This is used for DETECTION only (where the face is). It is not a recognition model:
    identity is decided exclusively by the PCA -> LDA -> classifier pipeline.
    """

    def detect(self, gray: np.ndarray) -> list[Box]:
        eq = cv2.equalizeHist(gray)
        found = _face_cascade().detectMultiScale(
            eq, scaleFactor=1.1, minNeighbors=5, minSize=(cfg.MIN_FACE_PIXELS // 2,) * 2
        )
        return [Box(int(x), int(y), int(w), int(h)) for (x, y, w, h) in found]


class FullFrameDetector:
    """Treats the whole image as one face. For pre-cropped images, tests and benchmarks."""

    def detect(self, gray: np.ndarray) -> list[Box]:
        h, w = gray.shape
        return [Box(0, 0, w, h)]


# ---------------------------------------------------------------- alignment


def roll_angle_degrees(left_eye: tuple[float, float], right_eye: tuple[float, float]) -> float:
    """Angle (deg) of the line from the image-left eye to the image-right eye."""
    return math.degrees(math.atan2(right_eye[1] - left_eye[1], right_eye[0] - left_eye[0]))


def rotate_to_level(
    gray: np.ndarray,
    center: tuple[float, float],
    left_eye: tuple[float, float],
    right_eye: tuple[float, float],
) -> np.ndarray:
    """Rotate the image about `center` so the eye line becomes horizontal."""
    angle = roll_angle_degrees(left_eye, right_eye)
    # OpenCV: positive angle = counter-clockwise, which lifts the image-right side.
    m = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(gray, m, (gray.shape[1], gray.shape[0]), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def _find_eyes(gray: np.ndarray, box: Box) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Locate both eyes inside the face box, or None if not confidently found."""
    cascade = _eye_cascade()
    if cascade.empty():
        return None
    top = gray[box.y : box.y + int(box.h * 0.6), box.x : box.x + box.w]
    min_size = max(8, box.w // 8)
    eyes = cascade.detectMultiScale(top, scaleFactor=1.1, minNeighbors=6, minSize=(min_size, min_size))
    if len(eyes) < 2:
        return None
    mid = box.w / 2
    left = [e for e in eyes if e[0] + e[2] / 2 < mid]
    right = [e for e in eyes if e[0] + e[2] / 2 >= mid]
    if not left or not right:
        return None
    lx, ly, lw, lh = max(left, key=lambda e: e[2] * e[3])
    rx, ry, rw, rh = max(right, key=lambda e: e[2] * e[3])
    le = (box.x + lx + lw / 2, box.y + ly + lh / 2)
    re = (box.x + rx + rw / 2, box.y + ry + rh / 2)
    if re[0] - le[0] < 0.25 * box.w:  # eyes implausibly close together
        return None
    return le, re


# ---------------------------------------------------------------- crop + quality


@dataclass(frozen=True)
class QualityReport:
    sharpness: float
    brightness: float
    face_size: int
    aligned: bool

    def as_dict(self) -> dict:
        return {
            "sharpness": round(self.sharpness, 2),
            "brightness": round(self.brightness, 2),
            "face_size": self.face_size,
            "aligned": self.aligned,
        }


@dataclass(frozen=True)
class ProcessedFace:
    crop: np.ndarray  # uint8, IMAGE_SIZE x IMAGE_SIZE, equalized. This is what gets stored.
    quality: QualityReport


def _square_crop(gray: np.ndarray, box: Box, margin: float = 0.08) -> np.ndarray:
    h_img, w_img = gray.shape
    cx, cy = box.x + box.w / 2, box.y + box.h / 2
    half = 0.5 * max(box.w, box.h) * (1 + 2 * margin)
    half = min(half, cx, cy, w_img - cx, h_img - cy)  # keep it square and inside the frame
    x0, x1 = int(round(cx - half)), int(round(cx + half))
    y0, y1 = int(round(cy - half)), int(round(cy + half))
    return gray[y0:y1, x0:x1]


def crop_to_stored(face: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Resize a face crop to the canonical size. Returns (equalized_crop, sharpness, brightness)."""
    small = cv2.resize(face, (cfg.IMAGE_SIZE, cfg.IMAGE_SIZE), interpolation=cv2.INTER_AREA)
    sharpness = float(cv2.Laplacian(small, cv2.CV_64F).var())
    brightness = float(small.mean())
    return cv2.equalizeHist(small), sharpness, brightness


def process_gray(
    gray: np.ndarray,
    detector: FaceDetector,
    *,
    check_quality: bool = True,
    second_face_ratio: float = cfg.SECOND_FACE_RATIO,
) -> ProcessedFace:
    """Detect, align, crop and quality-check a grayscale frame."""
    h, w = gray.shape
    scale = cfg.DETECTION_MAX_SIDE / max(h, w)
    if scale < 1:
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

    boxes = sorted(detector.detect(gray), key=lambda b: b.area, reverse=True)
    if not boxes:
        raise FaceImageError(NO_FACE, "No face found. Face the camera in good light and try again.")
    if len(boxes) > 1 and boxes[1].area >= second_face_ratio * boxes[0].area:
        raise FaceImageError(MULTIPLE_FACES, "More than one face is visible. Make sure only you are in frame.")
    box = boxes[0]
    if box.w < cfg.MIN_FACE_PIXELS and not isinstance(detector, FullFrameDetector):
        raise FaceImageError(FACE_TOO_SMALL, "Your face is too far away. Move closer to the camera.")

    aligned = False
    if not isinstance(detector, FullFrameDetector):
        eyes = _find_eyes(gray, box)
        if eyes is not None and abs(roll_angle_degrees(*eyes)) <= cfg.MAX_ROLL_DEGREES:
            center = (box.x + box.w / 2, box.y + box.h / 2)
            gray = rotate_to_level(gray, center, *eyes)
            aligned = True

    stored, sharpness, brightness = crop_to_stored(_square_crop(gray, box))
    report = QualityReport(sharpness, brightness, box.w, aligned)

    if check_quality:
        if brightness < cfg.BRIGHTNESS_RANGE[0]:
            raise FaceImageError(TOO_DARK, "The image is too dark. Add some light and try again.")
        if brightness > cfg.BRIGHTNESS_RANGE[1]:
            raise FaceImageError(TOO_BRIGHT, "The image is too bright. Reduce glare and try again.")
        if sharpness < cfg.MIN_SHARPNESS:
            raise FaceImageError(TOO_BLURRY, "The image is blurry. Hold still and try again.")
    return ProcessedFace(stored, report)


def extract_face(
    data: bytes, detector: FaceDetector, *, second_face_ratio: float = cfg.SECOND_FACE_RATIO
) -> ProcessedFace:
    """Uploaded image bytes -> processed face crop. Raises FaceImageError for fixable problems."""
    return process_gray(decode_image(data), detector, second_face_ratio=second_face_ratio)


# ---------------------------------------------------------------- crop -> vector


@lru_cache(maxsize=1)
def face_mask() -> np.ndarray:
    """Boolean elliptical mask that drops corners (background, hair, collar)."""
    size = cfg.IMAGE_SIZE
    m = np.zeros((size, size), np.uint8)
    cv2.ellipse(m, (size // 2, size // 2), (int(size * 0.44), int(size * 0.49)), 0, 0, 360, 1, -1)
    return m.astype(bool)


def vectorize(crop: np.ndarray) -> np.ndarray:
    """Stored 64x64 crop -> float32 feature vector (length IMAGE_SIZE^2).

    Inside the elliptical mask the pixels are standardized to zero mean and unit variance,
    which removes global brightness/contrast; outside the mask they are 0 (the mean).
    """
    mask = face_mask()
    v = crop.astype(np.float32)
    inside = v[mask]
    std = float(inside.std())
    out = np.zeros_like(v)
    out[mask] = (inside - inside.mean()) / (std if std > 1e-6 else 1.0)
    return out.ravel()


def vectorize_many(crops: np.ndarray) -> np.ndarray:
    return np.stack([vectorize(c) for c in crops])
