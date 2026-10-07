"""Within-class vs between-class variation, measured in pixel, PCA and LDA space.

For samples x with class means mu_c and global mean mu:
    S_w = sum_c sum_{x in c} (x - mu_c)(x - mu_c)^T      (within-class scatter)
    S_b = sum_c n_c (mu_c - mu)(mu_c - mu)^T             (between-class scatter)
The traces are computed directly (no D x D matrix). The Fisher criterion
J = trace(S_w^-1 S_b) is computed only where S_w is invertible (PCA and LDA space).
"""

import numpy as np

from app.ml.pipeline import FacePipeline


def scatter_traces(Z: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    mu = Z.mean(axis=0)
    within = between = 0.0
    for c in np.unique(y):
        zc = Z[y == c]
        mc = zc.mean(axis=0)
        within += float(((zc - mc) ** 2).sum())
        between += len(zc) * float(((mc - mu) ** 2).sum())
    return within, between


def fisher_criterion(Z: np.ndarray, y: np.ndarray) -> float | None:
    """trace(S_w^-1 S_b), or None if S_w is singular."""
    d = Z.shape[1]
    mu = Z.mean(axis=0)
    sw = np.zeros((d, d))
    sb = np.zeros((d, d))
    for c in np.unique(y):
        zc = Z[y == c]
        mc = zc.mean(axis=0)
        diff = zc - mc
        sw += diff.T @ diff
        m = (mc - mu)[:, None]
        sb += len(zc) * (m @ m.T)
    if np.linalg.matrix_rank(sw) < d:
        return None
    return float(np.trace(np.linalg.solve(sw, sb)))


def _describe(Z: np.ndarray, y: np.ndarray, with_fisher: bool) -> dict:
    within, between = scatter_traces(Z, y)
    return {
        "dim": int(Z.shape[1]),
        "trace_within": round(within, 4),
        "trace_between": round(between, 4),
        "between_over_within": round(between / within, 4) if within > 0 else None,
        "fisher_criterion": (lambda j: None if j is None else round(j, 4))(fisher_criterion(Z, y)) if with_fisher else None,
    }


def scatter_analysis(model: FacePipeline, X: np.ndarray, y: np.ndarray) -> dict:
    """Class separation before PCA, after PCA, and after LDA, on the given samples."""
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y)
    z_pca = model.pca_.transform(X)
    out = {
        "pixel_space": _describe(X, y, with_fisher=False),
        "pca_space": _describe(z_pca, y, with_fisher=True),
    }
    if model.lda_ is not None:
        out["lda_space"] = _describe(model.lda_.transform(z_pca), y, with_fisher=True)
    return out
