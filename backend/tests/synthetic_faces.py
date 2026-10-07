"""Synthetic 'faces' for tests: each identity is a fixed random low-frequency pattern with
fine detail; a sample is that pattern with a small shift, brightness change and noise.
They are NOT faces. They exercise the pipeline/API mechanics with controllable class
structure; accuracy on real faces is measured separately (ml/experiments, ORL)."""

import cv2
import numpy as np

SIZE = 96


def identity_pattern(identity: int) -> np.ndarray:
    rng = np.random.default_rng(1000 + identity)
    coarse = rng.normal(size=(6, 6)).astype(np.float32)
    base = cv2.resize(coarse, (SIZE + 16, SIZE + 16), interpolation=cv2.INTER_CUBIC)
    fine = cv2.GaussianBlur(rng.normal(size=(SIZE + 16, SIZE + 16)).astype(np.float32), (0, 0), 1.2)
    return base + 1.5 * fine


def sample_image(identity: int, variation: int, noise: float = 0.15) -> np.ndarray:
    rng = np.random.default_rng(10_000 * (identity + 1) + variation)
    pat = identity_pattern(identity)
    dx, dy = rng.integers(0, 9, size=2)
    img = pat[dy : dy + SIZE, dx : dx + SIZE] + rng.normal(scale=noise, size=(SIZE, SIZE))
    img = (img - img.min()) / (img.max() - img.min())
    img = np.clip(img * rng.uniform(0.7, 1.0) * 200 + rng.uniform(20, 50), 0, 255)
    return img.astype(np.uint8)


def png_bytes(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()
