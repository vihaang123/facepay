"""The recognition recipe in one place: how a model and its thresholds are produced from stored crops, and how one captured
frame is turned into evidence for the decision policy. The service uses these functions, and so does the offline evaluation
(ml/experiments/auth_policy_v4.py), so what is measured offline is the code that runs in production (not a re-implementation).
"""

from dataclasses import dataclass

import numpy as np

from app.ml import config as cfg
from app.ml.augment import AugmentedSet
from app.ml.evaluation import compare_and_select, user_thresholds
from app.ml.pipeline import FacePipeline
from app.ml.preprocessing import vectorize, vectorize_many
from app.services.auth_policy import FrameIdentity


@dataclass
class Trained:
    model: FacePipeline
    chosen: str  # "knn" | "svm"
    scheme: str  # cross-validation scheme
    results: dict  # per-variant cross-validated metrics (with the private _genuine_* arrays)
    pooled_threshold: float
    user_thresholds: dict[int, float]
    recall: dict[int, float]  # per-user out-of-fold recall
    X: np.ndarray  # vectors of the original samples
    X_fit: np.ndarray  # what the final model learned from: originals + augmented copies
    y_fit: np.ndarray


def train_recognizer(
    crops: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray | None,
    *,
    copies: int = cfg.AUGMENT_COPIES,
    calibration_copies: int = cfg.CALIBRATION_COPIES,
    percentile: float = cfg.DISTANCE_THRESHOLD_PERCENTILE,
    per_user: bool = True,
) -> Trained:
    """Cross-validate, pick the classifier, fit the deployed model and calibrate the thresholds.

    The defaults are the deployed recipe. copies=0, calibration_copies=0, percentile=70, per_user=False reproduces the
    previous recipe, which the offline evaluation uses as its baseline."""
    y = np.asarray(y)
    X = vectorize_many(crops)
    aug = AugmentedSet.build(crops, copies, calibration_copies) if (copies or calibration_copies) else None
    results, chosen, scheme = compare_and_select(X, y, groups, aug=aug)
    X_fit = np.concatenate([X, *aug.train]) if aug is not None else X
    y_fit = np.concatenate([y] * (len(X_fit) // len(X)))
    model = FacePipeline(use_lda=True, classifier=chosen).fit(X_fit, y_fit)
    deployed = results[f"pca_lda_{chosen}"]
    pooled, per = user_thresholds(deployed["_genuine_distances"], deployed["_genuine_labels"], percentile)
    if not per_user:
        per = {u: pooled for u in per}
    return Trained(model, chosen, scheme, results, pooled, per, deployed["per_user_recall"], X, X_fit, y_fit)


def frame_identity(model: FacePipeline, user_id: int, centroid: np.ndarray, crop: np.ndarray) -> FrameIdentity:
    """Evidence from one captured face crop for the claim "this is user_id": is it classified as them, how strongly, and how
    far is it from their profile centre."""
    x = vectorize(crop)[None, :]
    z = model.transform(x)
    label = model.clf_.predict(z)[0]
    mine = float(model.predict_proba(x)[0][list(model.classes_).index(user_id)])  # the score of YOUR class only
    return FrameIdentity(predicted_is_user=int(label) == user_id, confidence=mine, distance=float(np.linalg.norm(z[0] - centroid)))
