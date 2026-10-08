"""Phase 7 final evaluation: one reproducible run that regenerates every number in docs/final/evaluation-results.md.

    backend/.venv/bin/python ml/experiments/final_evaluation.py --orl PATH/orl.npz --out ml/results/final_evaluation.json

Nothing here changes the methodology. It reuses the Phase 3/4 code (app.ml.evaluation, app.ml.pipeline,
benchmark.open_set) and only adds (a) training-set (resubstitution) numbers kept separate from
out-of-fold numbers, (b) repeated CV with different shuffles for a spread estimate, (c) confusion matrices,
and (d) a scripted re-measurement of liveness detector jitter and of what the liveness rule does with
static / laterally-shifted still images.

Seeds: CV split seed 0 (the app's seed) for the headline numbers; seeds 0-4 for the spread;
open-set repeats use seeds 0..19; liveness noise seed 0.
"""

import cv2
import numpy as np
from sklearn.metrics import accuracy_score
from sklearn.model_selection import StratifiedKFold

from common import load_orl, parse_args, save_json, vectors
from benchmark import PERCENTILES, open_set
from app.ml import config as cfg
from app.ml import liveness as lv
from app.ml.evaluation import VARIANTS, evaluate_variant, make_splits, strip_private
from app.ml.pipeline import FacePipeline
from app.ml.preprocessing import HaarFaceDetector


def closed_set(X, y):
    splits, scheme = make_splits(y, None)
    res = {n: evaluate_variant(p, X, y, splits) for n, p in VARIANTS.items()}
    out = {"protocol": scheme + ", all 400 images, every score is out-of-fold", "variants": {}}
    for name, params in VARIANTS.items():
        model = FacePipeline(**params).fit(X, y)
        train_acc = float(accuracy_score(y, model.predict(X)))
        info = model.describe()
        spread = []
        for seed in range(5):
            sp = [(tr, te) for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(X, y)]
            r = evaluate_variant(params, X, y, sp)
            spread.append((r["accuracy"], r["macro_f1"]))
        s = np.array(spread)
        r = strip_private({name: res[name]})[name]
        r["training_accuracy_resubstitution"] = round(train_acc, 4)
        r["cv_accuracy_seeds0to4_mean_std"] = [round(float(s[:, 0].mean()), 4), round(float(s[:, 0].std()), 4)]
        r["cv_macro_f1_seeds0to4_mean_std"] = [round(float(s[:, 1].mean()), 4), round(float(s[:, 1].std()), 4)]
        r["dimensions"] = {"input": info["input_dim"], "pca_components": info["pca"]["n_components"],
                           "pca_variance_retained": info["pca"]["explained_variance_ratio_sum"],
                           "lda_components": info["lda"]["n_components"] if params["use_lda"] else None}
        out["variants"][name] = r
    return out


def open_set_summary(X, y, repeats):
    runs = [open_set(X, y, i) for i in range(repeats)]
    out = {}
    for p in PERCENTILES:
        out[str(p)] = {}
        for k in runs[0][p]:
            v = np.array([r[p][k] for r in runs])
            out[str(p)][k] = [round(float(v.mean()), 4), round(float(v.std()), 4)]
    return {"setup": f"30 enrolled x 6 images, 4 genuine probes each, 10 impostor subjects, {repeats} random subject splits (seeds 0..{repeats - 1}); values = mean, std",
            "by_threshold_percentile": out, "deployed_percentile": cfg.DISTANCE_THRESHOLD_PERCENTILE}


def paste(face, x, w=200, size=(640, 480)):
    h = int(w * face.shape[0] / face.shape[1])
    f = cv2.resize(face, (w, h), interpolation=cv2.INTER_LINEAR)
    bg = np.full((size[1], size[0]), 128, np.uint8)
    y0 = (size[1] - h) // 2
    bg[y0:y0 + h, x:x + w] = f
    return bg


def degrade(img, rng, sigma=4.0):
    noisy = np.clip(img + rng.normal(0, sigma, img.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", noisy, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)


def liveness(orl_X, y, n_subjects=40):
    rng = np.random.default_rng(0)
    det = HaarFaceDetector()
    faces = [orl_X[np.flatnonzero(y == s)[0]] for s in range(n_subjects)]
    jit, detected, total = [], 0, 0
    static_pass, shift_pass = dict.fromkeys(("turn_left", "turn_right"), 0), dict.fromkeys(("turn_left", "turn_right"), 0)
    sequences = 0
    for face in faces:
        obs = [lv.observe(degrade(paste(face, 220), rng), det) for _ in range(9)]
        total += len(obs)
        ok = [o for o in obs if o.faces == 1]
        detected += len(ok)
        if len(ok) < 9:
            continue
        cx = np.array([o.center_x for o in ok])
        w = np.array([o.width for o in ok])
        jit.extend((np.abs(cx - np.median(cx)) / np.median(w)).tolist())
        sequences += 1
        for ch in static_pass:
            static_pass[ch] += lv.evaluate(ch, obs).passed
            # attack not defended: the SAME still photo slid sideways by 0.18 box widths during the turn phase
            sign = -1 if ch == "turn_right" else 1
            frames = [lv.observe(degrade(paste(face, 220), rng), det) for _ in range(2)]
            for m in (0.04, 0.10, 0.16, 0.18, 0.18):
                frames.append(lv.observe(degrade(paste(face, 220 + int(round(sign * m * 200))), rng), det))
            shift_pass[ch] += lv.evaluate(ch, frames).passed
    jit = np.array(jit)
    return {
        "method": "ORL faces pasted at 200 px width into 640x480 frames, Gaussian noise sigma=4 + JPEG q80, Haar detector, 9 frames per face",
        "faces_tested": n_subjects, "frames": total, "frames_with_exactly_one_face": detected,
        "static_sequences_evaluated": sequences,
        "jitter_box_widths": {"p50": round(float(np.percentile(jit, 50)), 4), "p99": round(float(np.percentile(jit, 99)), 4), "max": round(float(jit.max()), 4)},
        "lateral_threshold": cfg.LATERAL_THRESHOLD, "baseline_max_drift": cfg.BASELINE_MAX_DRIFT,
        "threshold_over_max_jitter": round(cfg.LATERAL_THRESHOLD / float(jit.max()), 1),
        "static_photo_passes": static_pass,
        "slid_still_photo_passes": shift_pass,
        "note": "slid_still_photo_passes counts how often a flat photo translated sideways satisfies the challenge. The rule measures face-box movement, so a translated flat image can satisfy it; this is a known limitation, not a defended attack.",
    }


def main():
    a = parse_args(__doc__)
    d = np.load(a.orl)
    crops, y = load_orl(a.orl)
    X = vectors(crops)
    out = {
        "dataset": "AT&T/ORL Database of Faces, 40 subjects x 10 images",
        "closed_set": closed_set(X, y),
        "open_set": open_set_summary(X, y, a.repeats),
        "liveness": liveness(d["X"][:, 10:102, :], d["y"]),
        "config": {"pca_variance": cfg.PCA_VARIANCE, "knn_neighbors": cfg.KNN_NEIGHBORS,
                   "threshold_percentile": cfg.DISTANCE_THRESHOLD_PERCENTILE, "auth_min_confidence": cfg.AUTH_MIN_CONFIDENCE},
    }
    save_json(out, a.out)
    for k, v in out["closed_set"]["variants"].items():
        print(k, v["accuracy"], v["macro_precision"], v["macro_recall"], v["macro_f1"], "train", v["training_accuracy_resubstitution"], v["dimensions"])
    print(out["liveness"])


if __name__ == "__main__":
    main()
