"""Evidence for the face-count rule: raw Haar boxes vs distinct, supported faces.

    backend/.venv/bin/python ml/experiments/detection_evidence.py --orl PATH/orl.npz --out ml/results/detection_evidence.json

Setting (stated so nobody over-reads it): ORL photographs (grayscale, 92x112) are enlarged and pasted into a smoothed
random-noise 640x480 background, JPEG quality 80, then run through the REAL OpenCV Haar detector. This is NOT a webcam.
It measures how often the detector reports a spurious second box on a frame that contains exactly one face, and how often
it reports a real second person, under each counting rule. A real room has different clutter, so the absolute rates will
differ on a phone; the point is the comparison between rules on identical frames.

Rules compared (all on the same frames):
  raw        every box counts; a second box >= 15% of the largest => "multiple faces" (the rule that shipped)
  distinct   overlapping/nested boxes are one face (non-maximum suppression)
  supported  distinct + a second box needs cascade confidence >= SECOND_FACE_MIN_WEIGHT (what the app now does)
Sequence rule (what the app now does for an 8-9 frame attempt): reject only if a second face is seen in >= 3 frames.
"""

import cv2
import numpy as np

from common import parse_args, save_json
from app.ml import config as cfg
from app.ml.preprocessing import Box, _face_cascade, distinct_faces


def detect_scored(gray):
    eq = cv2.equalizeHist(gray)
    found, _, weights = _face_cascade().detectMultiScale3(
        eq, scaleFactor=1.1, minNeighbors=5, minSize=(cfg.MIN_FACE_PIXELS // 2,) * 2, outputRejectLevels=True
    )
    return [(Box(int(x), int(y), int(w), int(h)), float(wt)) for (x, y, w, h), wt in zip(found, weights, strict=False)]


def count(scored, floor, ratio=cfg.AUTH_SECOND_FACE_RATIO):
    """Distinct faces >= ratio of the largest, where every face after the largest needs cascade confidence >= floor.
    floor=None is the old behaviour: raw boxes, no suppression."""
    boxes = [b for b, _ in scored]
    if not boxes:
        return 0
    if floor is None:
        ordered = sorted(boxes, key=lambda b: b.area, reverse=True)
        return sum(1 for b in ordered if b.area >= ratio * ordered[0].area)
    by_box = {id(b): w for b, w in scored}
    ordered = distinct_faces(boxes)
    kept = [ordered[0]] + [b for b in ordered[1:] if by_box[id(b)] >= floor]
    return sum(1 for b in kept if b.area >= ratio * kept[0].area)


FLOORS = [None, 0.0, 3.0, 3.5, 4.0, 5.0]  # None = raw boxes; 0.0 = suppression of duplicates only
KS = (1, 2, 3, 4)  # an attempt (8 frames) is rejected when a second face is seen in at least k frames


def name(f):
    return "raw" if f is None else ("dedupe_only" if f == 0.0 else f"weight>={f}")


def background(rng):
    return cv2.GaussianBlur(rng.normal(110, 25, (480, 640)).clip(0, 255).astype(np.uint8), (0, 0), 6)


def jpeg(frame):
    return cv2.imdecode(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])[1], cv2.IMREAD_GRAYSCALE)


def main():
    args = parse_args("Face-count evidence")
    X = np.load(args.orl)["X"]
    rng = np.random.default_rng(args.seed)
    out = {"setting": __doc__.split("Rules compared")[0].strip(), "deployed": {"floor": cfg.SECOND_FACE_MIN_WEIGHT, "k_of_9": "max(2, ceil(0.3 n))"}}

    # 1. frames with exactly one face. Each attempt = 8 frames with fresh noise, JPEG and placement.
    attempts = []
    missed = 0
    for i in range(0, len(X), 2):
        face = cv2.resize(X[i], None, fx=2.6, fy=2.6)
        h, w = face.shape
        frames = []
        for _ in range(8):
            frame = background(rng)
            y0, x0 = int(rng.integers(0, 480 - h)), int(rng.integers(0, 640 - w))
            frame[y0 : y0 + h, x0 : x0 + w] = face
            scored = detect_scored(jpeg(frame))
            missed += not scored
            frames.append(scored)
        attempts.append(frames)
    single = {"attempts": len(attempts), "frames": 8 * len(attempts), "frames_with_no_face_found": missed, "rules": {}}
    for f in FLOORS:
        per_attempt = [sum(count(sc, f) > 1 for sc in frames) for frames in attempts]
        single["rules"][name(f)] = {
            "frames_wrongly_multiple": round(sum(per_attempt) / (8 * len(attempts)), 4),
            **{f"attempts_rejected_if_seen_in_{k}_or_more_frames": f"{sum(c >= k for c in per_attempt)}/{len(attempts)}" for k in KS},
        }
    out["single_face_frames"] = single

    # 2. a real second person of several relative sizes
    two = {}
    for rel in (0.35, 0.55, 0.9):
        pairs = []
        for i in range(0, len(X), 6):
            a = cv2.resize(X[i], None, fx=2.6, fy=2.6)
            b = cv2.resize(X[(i + 137) % len(X)], None, fx=2.6 * rel, fy=2.6 * rel)
            ha, wa = a.shape
            hb, wb = b.shape
            frames = []
            for _ in range(8):
                frame = background(rng)
                frame[100 : 100 + ha, 20 : 20 + wa] = a
                frame[150 : 150 + hb, 640 - 20 - wb : 640 - 20] = b
                frames.append(detect_scored(jpeg(frame)))
            pairs.append(frames)
        row = {"relative_width": rel, "relative_area": round(rel * rel, 2), "attempts": len(pairs), "rules": {}}
        for f in FLOORS:
            # ratio 0: this measures whether the detector sees the second person at all; size gating is separate
            per_attempt = [sum(count(sc, f, ratio=0.0) > 1 for sc in frames) for frames in pairs]
            row["rules"][name(f)] = {"per_frame_seen": round(sum(per_attempt) / (8 * len(pairs)), 3),
                                     **{f"attempts_rejected_if_seen_in_{k}_or_more_frames": f"{sum(c >= k for c in per_attempt)}/{len(pairs)}" for k in KS}}
        two[str(rel)] = row
    out["real_second_person"] = two
    print(__import__("json").dumps(out, indent=1))
    save_json(out, args.out)


if __name__ == "__main__":
    main()
