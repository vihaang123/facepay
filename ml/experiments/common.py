"""Shared helpers for the offline ML experiments (not deployed with the backend).

Run scripts from the repo root with the backend virtualenv, e.g.
    backend/.venv/bin/python ml/experiments/feasibility.py --orl /path/to/orl.npz

The real-face benchmark is the AT&T/ORL database (40 subjects x 10 images, 112x92, free for
research use). It is NOT committed to this repository; pass its location with --orl.
The npz must contain X (400,112,92) uint8 and y (400,) subject ids.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND))

from app.ml.preprocessing import crop_to_stored, vectorize_many  # noqa: E402


def parse_args(description: str) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--orl", required=True, help="path to orl.npz (X, y)")
    p.add_argument("--repeats", type=int, default=20)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", help="write results JSON here")
    return p.parse_args()


def load_orl(path: str) -> tuple[np.ndarray, np.ndarray]:
    """ORL images -> app-identical feature vectors (center square crop, 64x64, equalize, mask, z-score)."""
    d = np.load(path)
    crops = np.stack([crop_to_stored(im[10:102, :])[0] for im in d["X"]])
    return crops, d["y"]


def vectors(crops: np.ndarray) -> np.ndarray:
    return vectorize_many(crops)


def save_json(obj, path: str | None) -> None:
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(obj, indent=2))
        print(f"wrote {path}")


class Timer:
    def __enter__(self):
        self.t = time.perf_counter()
        return self

    def __exit__(self, *a):
        self.seconds = time.perf_counter() - self.t
