"""Cross-validated evaluation on the enrolled data (never on training predictions).

Splits: GroupKFold by pose tag when every user has >= 2 poses (so a fold is tested on poses it
did not train on, and burst-captured near-duplicates cannot leak across folds); otherwise
StratifiedKFold. All numbers returned come from out-of-fold predictions.
"""

import time

import numpy as np
from sklearn.metrics import accuracy_score, confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import GroupKFold, StratifiedKFold

from app.ml import config as cfg
from app.ml.pipeline import FacePipeline, InsufficientDataError

VARIANTS = {
    "pca_knn": dict(use_lda=False, classifier="knn"),
    "pca_lda_knn": dict(use_lda=True, classifier="knn"),
    "pca_lda_svm": dict(use_lda=True, classifier="svm"),
}


def make_splits(y: np.ndarray, groups: np.ndarray | None, max_splits: int = 5):
    """List of (train_idx, test_idx), plus a label for the scheme. Every train fold keeps >= 2 classes."""
    y = np.asarray(y)
    classes, counts = np.unique(y, return_counts=True)
    if len(classes) < 2:
        raise InsufficientDataError("Cross-validation needs at least 2 users.")
    if groups is not None:
        groups = np.asarray(groups)
        # per-user pose count
        if all(len(np.unique(groups[y == c])) >= 2 for c in classes):
            n_groups = len(np.unique(groups))
            k = min(max_splits, n_groups)
            if k >= 2:
                splits = [(tr, te) for tr, te in GroupKFold(n_splits=k).split(np.zeros(len(y)), y, groups)]
                if all(len(np.unique(y[tr])) >= 2 for tr, _ in splits):
                    return splits, f"group_kfold_by_pose(k={k})"
    k = int(min(max_splits, counts.min()))
    if k < 2:
        raise InsufficientDataError("Each user needs at least 2 samples for cross-validation.")
    skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=0)
    return [(tr, te) for tr, te in skf.split(np.zeros(len(y)), y)], f"stratified_kfold(k={k})"


def evaluate_variant(params: dict, X: np.ndarray, y: np.ndarray, splits, pca_components=cfg.PCA_VARIANCE) -> dict:
    """Out-of-fold metrics for one pipeline variant, plus out-of-fold genuine distances (LDA/PCA space)."""
    y = np.asarray(y)
    pred = np.empty(len(y), dtype=y.dtype)
    seen = np.zeros(len(y), dtype=bool)
    genuine = np.full(len(y), np.nan)
    predict_ms = []
    for tr, te in splits:
        model = FacePipeline(pca_components=pca_components, **params).fit(X[tr], y[tr])
        t = time.perf_counter()
        z = model.transform(X[te])
        p = model.clf_.predict(z)
        predict_ms.append((time.perf_counter() - t) * 1000 / max(1, len(te)))
        pred[te] = p
        seen[te] = True
        for label in model.classes_:
            m = y[te] == label
            if m.any():
                genuine[te[m]] = model.distance_to_class(z[m], label)
    idx = np.flatnonzero(seen)
    labels = np.unique(y)
    prec, rec, f1, _ = precision_recall_fscore_support(y[idx], pred[idx], labels=labels, average="macro", zero_division=0)
    return {
        "accuracy": round(float(accuracy_score(y[idx], pred[idx])), 4),
        "macro_precision": round(float(prec), 4),
        "macro_recall": round(float(rec), 4),
        "macro_f1": round(float(f1), 4),
        "confusion_matrix": confusion_matrix(y[idx], pred[idx], labels=labels).tolist(),
        "labels": [int(v) for v in labels],
        "n_evaluated": int(len(idx)),
        "predict_ms_per_sample": round(float(np.mean(predict_ms)), 3),
        "_genuine_distances": genuine[~np.isnan(genuine)],
    }


def compare_and_select(X: np.ndarray, y: np.ndarray, groups: np.ndarray | None, pca_components=cfg.PCA_VARIANCE):
    """Evaluate all variants; pick the deployed classifier among the PCA+LDA ones by macro-F1 (tie -> KNN)."""
    splits, scheme = make_splits(y, groups)
    results = {name: evaluate_variant(p, X, y, splits, pca_components) for name, p in VARIANTS.items()}
    knn, svm = results["pca_lda_knn"], results["pca_lda_svm"]
    chosen = "svm" if svm["macro_f1"] > knn["macro_f1"] else "knn"
    return results, chosen, scheme


def genuine_threshold(distances: np.ndarray, percentile: float = cfg.DISTANCE_THRESHOLD_PERCENTILE) -> float:
    """Provisional accept threshold: the given percentile of out-of-fold genuine distances."""
    return float(np.percentile(distances, percentile))


def strip_private(results: dict) -> dict:
    return {k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")} for k, v in results.items()}
