"""PCA-LDA (the project's pipeline) versus a pretrained deep face network (dlib ResNet, 128-number embeddings), on the same
photos with the same splits. Also calibrates the distance thresholds the embedding engine uses.

    backend/.venv/bin/python ml/experiments/embedding_benchmark.py --orl /path/to/orl.npz --out ml/results/embedding_calibration.json

Needs dlib-bin and face_recognition_models (both in backend/requirements.txt). The real-face data is the AT&T/ORL database
(40 people x 10 grayscale photos). It is NOT in this repository, and it is a small, easy, studio-style set: use the numbers to
compare the two methods and to pick conservative thresholds, not as a promise about phone cameras. Repeat on a consented pilot
set of real captures before relying on any threshold.

Protocol, repeated REPEATS times with a fresh random split: 30 people enrolled (6 photos each become the reference), 10 people held
out as strangers. Genuine = the other 4 photos of each enrolled person. "Strangers accepted" = how often a held-out person is
accepted as the closest enrolled person at the threshold that accepts 90% of genuine photos.
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.ml import embedding as emb  # noqa: E402
from app.ml.pipeline import FacePipeline  # noqa: E402
from app.ml.preprocessing import FaceImageError, vectorize  # noqa: E402

REPEATS = 20


def embed_all(X):
    embedder, E, ok = emb.get_embedder(), np.zeros((len(X), 128), np.float32), np.zeros(len(X), bool)
    for i, im in enumerate(X):  # the same upscale + border the live checks use, so the small ORL faces are detectable
        big = cv2.copyMakeBorder(cv2.resize(im, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC), 60, 60, 100, 100, cv2.BORDER_REPLICATE)
        try:
            E[i], ok[i] = embedder.embed(big), True
        except FaceImageError:
            pass
    return E, ok


def eer_and_far(genuine, impostor):
    ths = np.sort(np.concatenate([genuine, impostor]))
    frr = np.array([(genuine > t).mean() for t in ths])
    far = np.array([(impostor <= t).mean() for t in ths])
    i = int(np.argmin(np.abs(frr - far)))
    t90 = float(np.percentile(genuine, 90))
    return float((frr[i] + far[i]) / 2), float((impostor <= t90).mean())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--orl", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    d = np.load(a.orl)
    X, y = d["X"], d["y"]
    E, ok = embed_all(X)
    V = np.stack([vectorize(cv2.equalizeHist(cv2.resize(im, (64, 64), interpolation=cv2.INTER_AREA))) for im in X])
    rng = np.random.default_rng(7)
    rows = {"pca_lda_knn": [], "dlib_embedding": []}
    gen_all, other_all, stranger_all = [], [], []
    for _ in range(REPEATS):
        subs = rng.permutation(40)
        enrolled, strangers = subs[:30], subs[30:]
        train, test = [], []
        for s in enrolled:
            p = rng.permutation([i for i in np.where(y == s)[0] if ok[i]])
            train += list(p[:6])
            test += list(p[6:])
        train, test = np.array(train), np.array(test)
        stranger_idx = np.array([i for s in strangers for i in np.where(y == s)[0] if ok[i]])
        # ---- PCA-LDA-KNN: distance to the predicted person's centroid in LDA space
        m = FacePipeline(classifier="knn").fit(V[train], y[train])
        z = m.transform(V[test])
        gen = np.array([np.linalg.norm(z[k] - m.centroids_[y[i]]) for k, i in enumerate(test)])
        zs = m.transform(V[stranger_idx])
        imp = np.array([min(np.linalg.norm(zs[k] - c) for c in m.centroids_.values()) for k in range(len(stranger_idx))])
        eer, far90 = eer_and_far(gen, imp)
        rows["pca_lda_knn"].append(((m.predict(V[test]) == y[test]).mean(), eer, far90))
        # ---- embeddings: mean of the 6 enrolment embeddings is the reference
        names = list(enrolled)
        T = np.stack([E[[i for i in train if y[i] == s]].mean(0) for s in names])
        D = np.linalg.norm(E[test][:, None, :] - T[None], axis=2)
        lab = np.array([names.index(y[i]) for i in test])
        gen = D[np.arange(len(test)), lab]
        imp = np.linalg.norm(E[stranger_idx][:, None, :] - T[None], axis=2).min(1)
        eer, far90 = eer_and_far(gen, imp)
        rows["dlib_embedding"].append(((D.argmin(1) == lab).mean(), eer, far90))
        gen_all += list(gen)
        other_all += list(np.where(np.arange(len(names))[None] == lab[:, None], np.inf, D).min(1))
        stranger_all += list(imp)
    gen_all, other_all, stranger_all = map(np.array, (gen_all, other_all, stranger_all))
    pct = lambda v, q: round(float(np.percentile(v, q)), 3)  # noqa: E731
    report = {
        "dataset": "ORL (AT&T) 40 people x 10 photos; NOT webcam or phone footage",
        "protocol": f"{REPEATS} random splits; 30 enrolled (6 reference photos), 10 held-out strangers",
        "detected": f"{int(ok.sum())}/{len(X)} photos had a face found by the embedding detector",
        "methods": {k: {"identification_accuracy": round(float(np.mean([r[0] for r in v])), 4), "equal_error_rate": round(float(np.mean([r[1] for r in v])), 4),
                        "strangers_accepted_when_90pct_of_genuine_pass": round(float(np.mean([r[2] for r in v])), 4)} for k, v in rows.items()},
        "embedding_distances": {
            "genuine_p50": pct(gen_all, 50), "genuine_p90": pct(gen_all, 90), "genuine_p99": pct(gen_all, 99), "genuine_max": round(float(gen_all.max()), 3),
            "closest_other_enrolled_min": round(float(other_all.min()), 3), "closest_other_enrolled_p1": pct(other_all, 1),
            "stranger_min": round(float(stranger_all.min()), 3), "stranger_p1": pct(stranger_all, 1),
        },
        "acceptance_by_threshold": {f"{t:.2f}": {"genuine": round(float((gen_all <= t).mean()), 4), "other_enrolled": round(float((other_all <= t).mean()), 4),
                                                  "stranger": round(float((stranger_all <= t).mean()), 4)} for t in (0.40, 0.42, 0.45, 0.50, 0.55, 0.60)},
        "chosen": "verify 0.42 (1:1), lookup 0.40 with a 0.05 margin over the runner-up (1:N); the library's usual 0.6 accepted ~70% of strangers here",
        "caveat": "provisional: re-measure on real phone captures (colour, varied light, glasses, ageing) before any real-money use",
    }
    Path(a.out).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
