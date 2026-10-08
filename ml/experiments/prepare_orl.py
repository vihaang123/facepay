"""Build orl.npz from the AT&T/ORL folder layout (s1..s40, each with 1.pgm..10.pgm, 92x112 grayscale).

    backend/.venv/bin/python ml/experiments/prepare_orl.py --src PATH/orl_faces --out PATH/orl.npz

Output: X (400, 112, 92) uint8, y (400,) with subject number - 1 (0..39), images in numeric order.
The dataset itself is not part of this repository (see docs/final/evaluation-results.md, "Dataset").
"""

import argparse
from pathlib import Path

import cv2
import numpy as np


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--src", required=True, help="folder containing s1..s40")
    p.add_argument("--out", required=True)
    a = p.parse_args()
    X, y = [], []
    for s in range(1, 41):
        for i in range(1, 11):
            im = cv2.imread(str(Path(a.src) / f"s{s}" / f"{i}.pgm"), cv2.IMREAD_GRAYSCALE)
            if im is None or im.shape != (112, 92):
                raise SystemExit(f"missing or unexpected image: s{s}/{i}.pgm")
            X.append(im)
            y.append(s - 1)
    np.savez_compressed(a.out, X=np.stack(X), y=np.array(y))
    print(f"wrote {a.out}: {len(X)} images, 40 subjects")


if __name__ == "__main__":
    main()
