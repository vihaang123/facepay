"""ORL benchmark: the three pipeline variants, PCA setting sweep, class-separation analysis
and an open-set (impostor) test of the distance threshold. Everything is measured here.

Closed-set: 5-fold stratified CV over all 400 images / 40 subjects (same code the API uses).
Open-set: enrol 30 subjects (6 images each; the other 4 are genuine probes), 10 other subjects
are impostors. An attempt is accepted iff predicted == claimed AND distance <= threshold,
with the threshold chosen exactly as in production (95th pct of out-of-fold genuine distances).
Impostors claim (a) a random enrolled identity, (b) the identity the classifier predicts for them.
"""

import numpy as np

from common import load_orl, parse_args, save_json, vectors
from app.ml.analysis import scatter_analysis
from app.ml.evaluation import VARIANTS, evaluate_variant, genuine_threshold, make_splits, strip_private
from app.ml.pipeline import FacePipeline


def closed_set(X, y):
    splits, scheme = make_splits(y, None)
    res = {name: evaluate_variant(p, X, y, splits) for name, p in VARIANTS.items()}
    sweep = {}
    for spec in (0.80, 0.90, 0.95, 0.99, "fisherface"):
        r = evaluate_variant(VARIANTS["pca_lda_knn"], X, y, splits, pca_components=spec)
        sweep[str(spec)] = {k: r[k] for k in ("accuracy", "macro_f1")}
    model = FacePipeline(classifier="knn").fit(X, y)
    info = model.describe()
    return {
        "validation": scheme,
        "variants": {k: {kk: vv for kk, vv in v.items() if kk not in ("confusion_matrix", "labels")} for k, v in strip_private(res).items()},
        "pca_sweep_pca_lda_knn": sweep,
        "scatter_full_data": scatter_analysis(model, X, y),
        "pca": info["pca"],
        "lda": {"n_components": info["lda"]["n_components"]},
    }


PERCENTILES = (50, 60, 70, 80, 90, 95)


def open_set(X, y, seed):
    rng = np.random.default_rng(seed)
    subjects = rng.permutation(np.unique(y))
    enrolled, strangers = subjects[:30], subjects[30:]
    tr, probe = [], []
    for s in enrolled:
        idx = rng.permutation(np.flatnonzero(y == s))
        tr.extend(idx[:6])
        probe.extend(idx[6:])
    tr, probe = np.array(tr), np.array(probe)
    imp = np.flatnonzero(np.isin(y, strangers))

    splits, _ = make_splits(y[tr], None)
    oof = evaluate_variant(VARIANTS["pca_lda_knn"], X[tr], y[tr], splits)
    model = FacePipeline(classifier="knn").fit(X[tr], y[tr])
    random_claim = rng.choice(enrolled, size=len(imp))
    pred_claim = model.predict(X[imp])

    def attempt(idx, claimed, thr):
        z = model.transform(X[idx])
        pred = model.clf_.predict(z)
        d = np.array([np.linalg.norm(z[i] - model.centroids_[claimed[i]]) for i in range(len(idx))])
        return (pred == claimed) & (d <= thr)

    out = {}
    for pct in PERCENTILES:
        thr = genuine_threshold(oof["_genuine_distances"], pct)
        out[pct] = {
            "threshold": thr,
            "false_reject_rate": float(1 - attempt(probe, y[probe], thr).mean()),
            "far_random_claim": float(attempt(imp, random_claim, thr).mean()),
            "far_claims_predicted_identity": float(attempt(imp, pred_claim, thr).mean()),
        }
    return out


def main():
    a = parse_args(__doc__)
    crops, y = load_orl(a.orl)
    X = vectors(crops)
    out = {"dataset": "AT&T/ORL, 40 subjects x 10 images", "closed_set": closed_set(X, y),
           "open_set": [open_set(X, y, a.seed + i) for i in range(a.repeats)]}
    out["open_set_mean"] = {
        str(pct): {k: round(float(np.mean([r[pct][k] for r in out["open_set"]])), 4) for k in out["open_set"][0][pct]}
        for pct in PERCENTILES
    }
    out["open_set_setup"] = "30 enrolled x 6 images, 4 genuine probes each, 10 impostor subjects; repeats=%d" % a.repeats
    cs = out["closed_set"]
    print(cs["validation"])
    for k, v in cs["variants"].items():
        print(f"{k:12s} acc={v['accuracy']:.3f} macroF1={v['macro_f1']:.3f} predict={v['predict_ms_per_sample']}ms")
    print("pca sweep:", cs["pca_sweep_pca_lda_knn"])
    print("pca:", cs["pca"], "lda:", cs["lda"])
    for sp in ("pixel_space", "pca_space", "lda_space"):
        print(sp, cs["scatter_full_data"][sp])
    print("open-set (threshold = percentile of out-of-fold genuine distances):")
    for pct, r in out["open_set_mean"].items():
        print(f"  p{pct}: thr={r['threshold']} FRR={r['false_reject_rate']} FAR(random claim)={r['far_random_claim']} FAR(claims predicted)={r['far_claims_predicted_identity']}")
    save_json(out, a.out)


if __name__ == "__main__":
    main()
