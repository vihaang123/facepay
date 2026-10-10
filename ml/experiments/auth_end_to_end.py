"""Genuine-user and impostor evaluation through the deployed capture path and decision policy.

    backend/.venv/bin/python ml/experiments/auth_end_to_end.py --orl PATH/orl.npz --out ml/results/auth_end_to_end.json

What is real: the OpenCV Haar detector, the app's preprocessing and quality gates (process_gray), PCA -> LDA -> the
classifier the app selects (compare_and_select), the per-model distance threshold (70th percentile of out-of-fold genuine
distances), and app.services.auth_policy.decide with every baseline frame having to pass.
What is NOT: ORL photographs pasted into noisy 640x480 JPEG frames are not webcam frames; ORL has 10 images per person (the
app asks for >= 12 per user), so each enrolled person here has 6 training and 4 held-out images; liveness is assumed passed
(this script measures RECOGNITION only; liveness is covered by tests); the three "baseline frames" of an attempt are three
DIFFERENT photographs (ORL photos differ more than consecutive webcam frames, so genuine acceptance is pessimistic).

Attempt = 3 baseline frames of one person claiming one enrolled account. Frames whose capture fails (no face found, blur...)
are skipped as in the app (2 usable frames are required); an attempt with fewer than 2 usable frames is counted separately as
a capture failure, never as a recognition decision. Held-out images are never used for training or threshold calibration.

Populations per trial (C enrolled people, a random sample of ORL subjects):
  genuine            held-out images of enrolled person A claiming A
  impostor_enrolled  held-out images of another ENROLLED person B claiming A
  impostor_unknown   images of people who were never enrolled claiming A
"""

import itertools
import math

import cv2
import numpy as np

from common import parse_args, save_json
from app.ml import config as cfg
from app.ml.evaluation import compare_and_select, genuine_threshold
from app.ml.pipeline import FacePipeline
from app.ml.preprocessing import FaceImageError, HaarFaceDetector, process_gray, vectorize
from app.services import auth_policy as policy


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 4), round(min(1, c + h), 4)]


def capture_all(X, seed):
    """Run every ORL image through the app's capture path once. Returns vectors (or None where capture fails)."""
    rng = np.random.default_rng(seed)
    det = HaarFaceDetector()
    vecs, why = [], []
    for img in X:
        face = cv2.resize(img, None, fx=2.6, fy=2.6)
        h, w = face.shape
        frame = cv2.GaussianBlur(rng.normal(110, 25, (480, 640)).clip(0, 255).astype(np.uint8), (0, 0), 6)
        y0, x0 = int(rng.integers(0, 480 - h)), int(rng.integers(0, 640 - w))
        frame[y0 : y0 + h, x0 : x0 + w] = face
        gray = cv2.imdecode(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])[1], cv2.IMREAD_GRAYSCALE)
        try:
            p = process_gray(gray, det, second_face_ratio=cfg.AUTH_SECOND_FACE_RATIO, reject_multiple=False)
            vecs.append(vectorize(p.crop))
            why.append(None)
        except FaceImageError as exc:
            vecs.append(None)
            why.append(exc.code)
    return vecs, why


def attempt(model, centroid, threshold, uid, vectors):
    usable = [v for v in vectors if v is not None]
    if len(usable) < cfg.BASELINE_MIN_USABLE:
        return "CAPTURE_FAILED"
    frames = []
    for v in usable:
        x = v[None, :]
        z = model.transform(x)
        label = model.clf_.predict(z)[0]
        mine = float(model.predict_proba(x)[0][list(model.classes_).index(uid)])
        frames.append(policy.FrameIdentity(int(label) == uid, mine, float(np.linalg.norm(z[0] - centroid))))
    d = policy.decide(policy.Evidence(liveness_passed=True, frames=tuple(frames), distance_threshold=threshold))
    return "ACCEPT" if d.authenticated else d.reason


def run(X, y, vecs, enrolled_count, trials, seed):
    rng = np.random.default_rng(seed)
    subjects = np.unique(y)
    out = {k: {} for k in ("genuine", "impostor_enrolled", "impostor_unknown")}
    for _ in range(trials):
        pick = rng.permutation(subjects)
        enrolled, unknown = pick[:enrolled_count], pick[enrolled_count : enrolled_count + 10]
        tr_x, tr_y, held = [], [], {}
        for s in enrolled:
            idx = rng.permutation(np.where(y == s)[0])
            ok_train = [i for i in idx[:6] if vecs[i] is not None]
            tr_x += [vecs[i] for i in ok_train]
            tr_y += [int(s)] * len(ok_train)
            held[int(s)] = list(idx[6:])
        if len(set(tr_y)) < 2 or min(tr_y.count(s) for s in set(tr_y)) < 3:
            continue
        Xt, yt = np.stack(tr_x), np.array(tr_y)
        results, chosen, _ = compare_and_select(Xt, yt, None)
        model = FacePipeline(use_lda=True, classifier=chosen).fit(Xt, yt)
        threshold = genuine_threshold(results[f"pca_lda_{chosen}"]["_genuine_distances"])
        for a in held:
            centroid = model.centroids_[a]
            for combo in itertools.combinations(held[a], 3):
                r = attempt(model, centroid, threshold, a, [vecs[i] for i in combo])
                out["genuine"][r] = out["genuine"].get(r, 0) + 1
            for b in held:
                if b == a:
                    continue
                for combo in itertools.combinations(held[b], 3):
                    r = attempt(model, centroid, threshold, a, [vecs[i] for i in combo])
                    out["impostor_enrolled"][r] = out["impostor_enrolled"].get(r, 0) + 1
            for u in unknown:
                idx = rng.permutation(np.where(y == u)[0])
                for combo in (idx[0:3], idx[3:6], idx[6:9]):
                    r = attempt(model, centroid, threshold, a, [vecs[i] for i in combo])
                    out["impostor_unknown"][r] = out["impostor_unknown"].get(r, 0) + 1
    summary = {}
    for pop, counts in out.items():
        n = sum(counts.values())
        decided = n - counts.get("CAPTURE_FAILED", 0)
        acc = counts.get("ACCEPT", 0)
        summary[pop] = {"attempts": n, "capture_failed": counts.get("CAPTURE_FAILED", 0), "decided": decided, "accepted": acc,
                        "accept_rate": round(acc / decided, 4) if decided else None, "accept_rate_95ci": wilson(acc, decided),
                        "outcomes": counts}
    return summary


def main():
    args = parse_args("End-to-end genuine/impostor evaluation")
    X, y = np.load(args.orl)["X"], np.load(args.orl)["y"]
    vecs, why = capture_all(X, args.seed)
    capture = {"images": len(X), "capture_failed": sum(v is None for v in vecs), "reasons": {k: why.count(k) for k in set(why) if k}}
    result = {"setting": __doc__, "capture": capture, "threshold_percentile": cfg.DISTANCE_THRESHOLD_PERCENTILE,
              "auth_min_confidence": cfg.AUTH_MIN_CONFIDENCE, "by_enrolled_people": {}}
    for c in (2, 5, 10):
        result["by_enrolled_people"][str(c)] = run(X, y, vecs, c, args.repeats, args.seed + c)
        s = result["by_enrolled_people"][str(c)]
        print(c, "enrolled:", {k: (v["accept_rate"], v["decided"]) for k, v in s.items()})
    save_json(result, args.out)


if __name__ == "__main__":
    main()
