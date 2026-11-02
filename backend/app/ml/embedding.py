"""Deep face embeddings: image -> 128 numbers that describe who is in it.

The default implementation is dlib's pretrained ResNet (the weights ship with the `face_recognition_models` package; nothing is
downloaded at run time). Everything outside this module sees only `FaceEmbedder.embed`, so tests use a stand-in and a better
network can replace dlib without touching the rest of the system.

Never stored or returned in the clear: embeddings are encrypted like every other piece of face data (face_service).
"""

import importlib.util
import threading
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from app.ml import config as cfg
from app.ml.preprocessing import MULTIPLE_FACES, NO_FACE, FaceImageError

DETECT_MAX_SIDE = 640


class EmbeddingUnavailable(RuntimeError):
    """The embedding library or its weights are not installed on this server."""


class FaceEmbedder(Protocol):
    def embed(self, gray: np.ndarray, *, second_face_ratio: float = cfg.SECOND_FACE_RATIO) -> np.ndarray:
        """(EMBED_DIM,) float32 for the one face in the image. Raises FaceImageError(NO_FACE | MULTIPLE_FACES)."""
        ...


class DlibEmbedder:
    def __init__(self) -> None:
        self._lock = threading.Lock()  # dlib's detector and network are not thread-safe
        self._ready = False

    def _load(self) -> None:
        try:
            import dlib
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise EmbeddingUnavailable("dlib is not installed") from exc
        spec = importlib.util.find_spec("face_recognition_models")  # located, not imported: its __init__ needs pkg_resources
        if spec is None or not spec.submodule_search_locations:
            raise EmbeddingUnavailable("face_recognition_models is not installed")
        models = Path(next(iter(spec.submodule_search_locations))) / "models"
        try:
            self._detector = dlib.get_frontal_face_detector()
            self._landmarks = dlib.shape_predictor(str(models / "shape_predictor_5_face_landmarks.dat"))
            self._net = dlib.face_recognition_model_v1(str(models / "dlib_face_recognition_resnet_model_v1.dat"))
        except RuntimeError as exc:  # pragma: no cover
            raise EmbeddingUnavailable("the face model files could not be loaded") from exc
        self._ready = True

    def embed(self, gray: np.ndarray, *, second_face_ratio: float = cfg.SECOND_FACE_RATIO) -> np.ndarray:
        with self._lock:
            if not self._ready:
                self._load()
            h, w = gray.shape[:2]
            scale = min(1.0, DETECT_MAX_SIDE / max(h, w))
            if scale < 1.0:
                gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            rgb = np.ascontiguousarray(cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB))
            rects = list(self._detector(rgb, 0)) or list(self._detector(rgb, 1))
            rects = [r for r in rects if r.width() >= cfg.EMBED_MIN_FRAME_SIDE]
            if not rects:
                raise FaceImageError(NO_FACE, "No face was found. Face the camera in good light.")
            rects.sort(key=lambda r: r.area(), reverse=True)
            if len(rects) > 1 and rects[1].area() >= second_face_ratio * rects[0].area():
                raise FaceImageError(MULTIPLE_FACES, "More than one face is in view. Only the account owner should be visible.")
            vec = self._net.compute_face_descriptor(rgb, self._landmarks(rgb, rects[0]), 0)
            return np.asarray(vec, dtype=np.float32)


_embedder: FaceEmbedder | None = None


@lru_cache(maxsize=1)
def _default() -> DlibEmbedder:
    return DlibEmbedder()


def get_embedder() -> FaceEmbedder:
    return _embedder if _embedder is not None else _default()


def set_embedder(embedder: FaceEmbedder | None) -> None:
    """Swap the embedder (tests). None restores the dlib default."""
    global _embedder
    _embedder = embedder


def distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(np.asarray(a, np.float64) - np.asarray(b, np.float64)))


def template(vectors: list[np.ndarray]) -> np.ndarray:
    """The customer's reference: the mean of their enrolment embeddings."""
    return np.mean(np.stack([np.asarray(v, np.float64) for v in vectors]), axis=0)


def score(d: float, threshold: float) -> float:
    """A 0..1 closeness score for the decision policy and the UI: 1 at distance 0, 0.5 exactly at the threshold, 0 at twice
    the threshold. It is NOT a probability."""
    return float(min(1.0, max(0.0, 1.0 - d / (2.0 * threshold))))
