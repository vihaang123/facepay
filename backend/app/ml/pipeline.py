"""PCA -> LDA -> classifier ("Fisherfaces"), as one scikit-learn compatible estimator.

Why both, and why in this order
-------------------------------
* Pixel vectors have D = 4096 dimensions but a user contributes only tens of samples.
  The within-class scatter matrix S_w then has rank <= N - C (N samples, C classes), so
  it is singular and plain LDA is undefined.
* PCA first projects to p <= N - C dimensions where S_w is full rank (Belhumeur et al.,
  "Eigenfaces vs. Fisherfaces", 1997). It also removes noise directions.
* LDA then finds the (at most C - 1) directions that maximize between-class scatter
  relative to within-class scatter, which is what we want for telling users apart.
* The classifier is trained ONLY on the LDA output, so both stages decide the result.

Hard limits that follow from the maths (surfaced as errors, never hidden):
* C >= 2 classes are required; LDA yields min(C - 1, p) components.
"""

from dataclasses import dataclass

import numpy as np
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.decomposition import PCA
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.neighbors import KNeighborsClassifier
from sklearn.svm import SVC

from app.ml import config as cfg


class InsufficientDataError(ValueError):
    """Not enough users or samples for the PCA -> LDA pipeline."""


@dataclass(frozen=True)
class PcaChoice:
    n_used: int
    n_for_variance: int | None
    cap: int  # N - C, the largest dimension that keeps S_w non-singular
    floored: bool  # raised so LDA can still produce C - 1 discriminants


def choose_pca_dimension(X: np.ndarray, y: np.ndarray, spec, use_lda: bool) -> PcaChoice:
    """Resolve the PCA dimension.

    spec: float in (0, 1)  -> smallest p reaching that explained-variance fraction
          int              -> fixed p
          "fisherface"     -> p = N - C (the classic choice)
    Always capped at N - C so S_w stays full rank.
    """
    n, d = X.shape
    c = len(np.unique(y))
    cap = max(1, min(n - c, d))
    n_var = None
    if spec == "fisherface":
        p = cap
    elif isinstance(spec, (int, np.integer)) and not isinstance(spec, bool):
        p = min(int(spec), cap)
    else:
        probe = PCA(n_components=cap, svd_solver="full").fit(X)
        cum = np.cumsum(probe.explained_variance_ratio_)
        n_var = int(min(np.searchsorted(cum, float(spec)) + 1, cap))
        p = n_var
    floored = False
    if use_lda:
        needed = min(c - 1, cap)
        if p < needed:
            p, floored = needed, True
    return PcaChoice(n_used=max(1, p), n_for_variance=n_var, cap=cap, floored=floored)


class FacePipeline(BaseEstimator, ClassifierMixin):
    """PCA -> (LDA) -> classifier. Set use_lda=False for the PCA-only baseline."""

    def __init__(
        self,
        use_lda: bool = True,
        classifier: str = "knn",
        pca_components=cfg.PCA_VARIANCE,
        knn_neighbors: int = cfg.KNN_NEIGHBORS,
        svm_c: float = 1.0,
        random_state: int = 0,
    ):
        self.use_lda = use_lda
        self.classifier = classifier
        self.pca_components = pca_components
        self.knn_neighbors = knn_neighbors
        self.svm_c = svm_c
        self.random_state = random_state

    # ------------------------------------------------------------ fit
    def fit(self, X, y):
        X = np.asarray(X, dtype=np.float64)
        y = np.asarray(y)
        classes, counts = np.unique(y, return_counts=True)
        if len(classes) < 2:
            raise InsufficientDataError("At least 2 enrolled users are required: LDA needs 2 or more classes.")
        if X.shape[0] <= len(classes):
            raise InsufficientDataError("More samples than users are required.")
        if self.classifier not in ("knn", "svm"):
            raise ValueError(f"unknown classifier {self.classifier!r}")

        self.classes_ = classes
        choice = choose_pca_dimension(X, y, self.pca_components, self.use_lda)
        self.pca_choice_ = choice
        self.pca_ = PCA(n_components=choice.n_used, svd_solver="full").fit(X)
        z = self.pca_.transform(X)

        if self.use_lda:
            self.lda_ = LinearDiscriminantAnalysis(
                solver="svd", n_components=min(len(classes) - 1, choice.n_used)
            ).fit(z, y)
            z = self.lda_.transform(z)
        else:
            self.lda_ = None

        if self.classifier == "knn":
            k = max(1, min(self.knn_neighbors, int(counts.min())))
            self.clf_ = KNeighborsClassifier(n_neighbors=k, weights="distance")
        else:
            self.clf_ = SVC(kernel="linear", C=self.svm_c, decision_function_shape="ovr")
        self.clf_.fit(z, y)

        self.centroids_ = {c: z[y == c].mean(axis=0) for c in classes}
        self.n_features_in_ = X.shape[1]
        self.n_samples_ = X.shape[0]
        return self

    # ------------------------------------------------------------ inference
    def transform(self, X) -> np.ndarray:
        """Pixels -> PCA -> LDA. This is the representation the classifier sees."""
        z = self.pca_.transform(np.asarray(X, dtype=np.float64))
        return self.lda_.transform(z) if self.lda_ is not None else z

    def predict(self, X):
        return self.clf_.predict(self.transform(X))

    def predict_proba(self, X):
        """Per-class scores in [0, 1] that sum to 1. NOT calibrated probabilities.

        KNN: distance-weighted vote share. SVM: softmax of the one-vs-rest decision values
        (sklearn's SVC(probability=True) is deprecated, and Platt scaling needs more samples
        per user than we can assume).
        """
        z = self.transform(X)
        if self.classifier == "knn":
            return self.clf_.predict_proba(z)
        d = self.clf_.decision_function(z)
        if d.ndim == 1:  # two classes: one signed margin
            d = np.stack([-d, d], axis=1)
        e = np.exp(d - d.max(axis=1, keepdims=True))
        return e / e.sum(axis=1, keepdims=True)

    def distance_to_class(self, z: np.ndarray, label) -> np.ndarray:
        """Euclidean distance from rows of z (already transformed) to a class centroid."""
        return np.linalg.norm(z - self.centroids_[label], axis=1)

    # ------------------------------------------------------------ description
    def describe(self) -> dict:
        """Configuration and fitted dimensions, JSON-serializable (stored with the model)."""
        c = len(self.classes_)
        ch = self.pca_choice_
        info = {
            "n_samples": int(self.n_samples_),
            "n_classes": int(c),
            "input_dim": int(self.n_features_in_),
            "pca": {
                "n_components": int(ch.n_used),
                "spec": self.pca_components if isinstance(self.pca_components, str) else float(self.pca_components),
                "n_for_variance_target": ch.n_for_variance,
                "cap_n_minus_c": int(ch.cap),
                "raised_for_lda": bool(ch.floored),
                "explained_variance_ratio_sum": round(float(self.pca_.explained_variance_ratio_.sum()), 4),
            },
            "classifier": self.classifier,
            "knn_k": int(self.clf_.n_neighbors) if self.classifier == "knn" else None,
        }
        if self.lda_ is not None:
            info["lda"] = {
                "n_components": int(self.lda_.n_components),
                "solver": "svd",
                "explained_between_class_variance": [round(float(v), 4) for v in self.lda_.explained_variance_ratio_[: self.lda_.n_components]],
            }
        else:
            info["lda"] = None
        return info
