"""Training-time augmentation of the stored 64x64 face crops.

Why: guided enrolment captures every sample within about a minute, from one device, in one light. A later check differs in
ways the samples never show: the detector box sits a few pixels differently, the face is a little nearer or further, the head
is slightly rotated, focus is softer, the light comes from one side. A pixel-based PCA/LDA model is sensitive to all of these,
so a genuine user can land far from their own profile. Perturbing each stored crop a little (and training on the copies)
teaches the model that spread. Nothing extra is stored: copies are made in memory from the same crops, deterministically.

The perturbations stay small on purpose. They must not turn one person into another; they only reproduce what a second
capture of the same face looks like.
"""

import cv2
import numpy as np

from app.ml import config as cfg
from app.ml.preprocessing import vectorize


def augment_crop(crop: np.ndarray, rng: np.random.Generator, strength: float = 1.0) -> np.ndarray:
    """One perturbed copy of a stored (equalised, uint8, IMAGE_SIZE x IMAGE_SIZE) crop. Equalised again, as at capture."""
    size = crop.shape[0]
    angle = rng.uniform(-cfg.AUGMENT_MAX_ROTATION, cfg.AUGMENT_MAX_ROTATION) * strength
    scale = 1.0 + rng.uniform(-cfg.AUGMENT_MAX_SCALE, cfg.AUGMENT_MAX_SCALE) * strength
    shift = rng.uniform(-cfg.AUGMENT_MAX_SHIFT, cfg.AUGMENT_MAX_SHIFT, 2) * size * strength
    m = cv2.getRotationMatrix2D((size / 2, size / 2), angle, scale)
    m[:, 2] += shift
    out = cv2.warpAffine(crop, m, (size, size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    # side lighting: a brightness ramp in a random direction (histogram equalisation alone cannot undo this one)
    theta = rng.uniform(0, 2 * np.pi)
    axis = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    ramp = np.cos(theta) * axis[None, :] + np.sin(theta) * axis[:, None]
    out = out + ramp * rng.uniform(0, cfg.AUGMENT_MAX_LIGHT_GRADIENT) * strength
    out = np.clip(out, 0, 255).astype(np.uint8)
    if rng.random() < 0.5:  # softer focus
        out = cv2.GaussianBlur(out, (0, 0), float(rng.uniform(0.4, 1.0)) * max(strength, 0.3))
    return cv2.equalizeHist(out)


def augmented_vectors(crops: np.ndarray, copies: int, seed: int, strength: float = 1.0) -> np.ndarray:
    """(copies, n, features): copy k of sample i is augmented_vectors(...)[k, i]. Deterministic for a given seed."""
    out = np.empty((copies, len(crops), cfg.IMAGE_SIZE * cfg.IMAGE_SIZE), dtype=np.float32)
    for k in range(copies):
        rng = np.random.default_rng([seed, k])
        for i, crop in enumerate(crops):
            out[k, i] = vectorize(augment_crop(crop, rng, strength))
    return out


class AugmentedSet:
    """Perturbed copies aligned with the original samples (same row order).

    train: copies used to FIT the model on the training side of a split (and the final model).
    calib: independent copies of the HELD-OUT samples, used only to calibrate the distance threshold.
    """

    def __init__(self, train: np.ndarray, calib: np.ndarray):
        self.train = train
        self.calib = calib

    @classmethod
    def build(cls, crops: np.ndarray, train_copies: int = cfg.AUGMENT_COPIES, calib_copies: int = cfg.CALIBRATION_COPIES) -> "AugmentedSet":
        return cls(
            augmented_vectors(crops, train_copies, cfg.AUGMENT_SEED),
            augmented_vectors(crops, calib_copies, cfg.AUGMENT_SEED + 1, cfg.AUGMENT_CALIBRATION_STRENGTH),
        )
