"""Is PCA -> LDA -> classifier appropriate for our data sizes? Measured on real faces (ORL).

For each (users C, training samples per user n) we draw C random subjects and n random
images per subject for training, test on the subject's remaining images, repeat, and report
mean +/- std accuracy for each pipeline variant. A second sweep varies the PCA setting.
Nothing here is hard-coded: every number printed comes from this run.
"""

import itertools

import numpy as np

from common import Timer, load_orl, parse_args, save_json, vectors
from app.ml.pipeline import FacePipeline

VARIANTS = {
    "PCA+KNN": dict(use_lda=False, classifier="knn"),
    "PCA+LDA+KNN": dict(use_lda=True, classifier="knn"),
    "PCA+LDA+SVM": dict(use_lda=True, classifier="svm"),
}


def draw(rng, y, c, n):
    subjects = rng.choice(np.unique(y), size=c, replace=False)
    tr, te = [], []
    for s in subjects:
        idx = rng.permutation(np.flatnonzero(y == s))
        tr.extend(idx[:n])
        te.extend(idx[n:])
    return np.array(tr), np.array(te)


def run(X, y, c, n, params, repeats, seed):
    rng = np.random.default_rng(seed)
    accs, secs = [], []
    for _ in range(repeats):
        tr, te = draw(rng, y, c, n)
        with Timer() as t:
            m = FacePipeline(**params).fit(X[tr], y[tr])
        accs.append(float((m.predict(X[te]) == y[te]).mean()))
        secs.append(t.seconds)
    return {"acc_mean": round(float(np.mean(accs)), 4), "acc_std": round(float(np.std(accs)), 4),
            "fit_seconds": round(float(np.mean(secs)), 3)}


def main():
    a = parse_args(__doc__)
    crops, y = load_orl(a.orl)
    X = vectors(crops)
    print(f"data: {X.shape[0]} images, {len(np.unique(y))} subjects, {X.shape[1]} features")

    grid = {}
    print("\n== users x samples-per-user (PCA variance 0.95) ==")
    for c, n in itertools.product([2, 3, 5, 10, 20, 40], [4, 6, 8]):
        row = {v: run(X, y, c, n, p, a.repeats, a.seed) for v, p in VARIANTS.items()}
        grid[f"C{c}_n{n}"] = row
        cells = "  ".join(f"{v}={r['acc_mean']:.3f}±{r['acc_std']:.3f}" for v, r in row.items())
        print(f"C={c:<2} n={n}: {cells}")

    sweep = {}
    print("\n== PCA setting sweep (C=10, n=6, PCA+LDA+KNN) ==")
    for spec in (0.80, 0.90, 0.95, 0.99, "fisherface"):
        r = run(X, y, 10, 6, dict(use_lda=True, classifier="knn", pca_components=spec), a.repeats, a.seed)
        sweep[str(spec)] = r
        print(f"pca={spec}: {r['acc_mean']:.3f}±{r['acc_std']:.3f}")

    save_json({"grid": grid, "pca_sweep": sweep, "repeats": a.repeats, "seed": a.seed}, a.out)


if __name__ == "__main__":
    main()
