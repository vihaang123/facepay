"""Enrollment, training and recognition for the PCA -> LDA -> classifier pipeline.

What is stored (and what is not):
* face_samples: 64x64 equalised grayscale crops, AES-GCM encrypted. Raw frames are never stored.
* model_versions: the fitted model (encrypted joblib), configuration and cross-validated metrics.
* face_profiles: per user, the encrypted class centroid in LDA space + distance threshold.
No endpoint returns an image, a crop, or a feature vector.
"""

import base64
import binascii
import hashlib
import json
import secrets
import threading
from collections import defaultdict
from datetime import UTC, datetime

import numpy as np
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core import crypto
from app.ml import config as cfg
from app.ml import registry
from app.ml.analysis import scatter_analysis
from app.ml.evaluation import compare_and_select, genuine_threshold, strip_private
from app.ml.pipeline import FacePipeline, InsufficientDataError
from app.ml.preprocessing import (
    INVALID_IMAGE,
    FaceDetector,
    FaceImageError,
    extract_face,
    vectorize,
    vectorize_many,
)
from app.ml.serialization import dump_model, library_versions
from app.models import FaceProfile, FaceSample, ModelVersion, User


class FaceServiceError(Exception):
    status = 400

    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code, self.message = code, message
        if status:
            self.status = status


_train_lock = threading.Lock()


# ---------------------------------------------------------------- helpers


def decode_upload(image_base64: str) -> bytes:
    s = image_base64.strip()
    if s.startswith("data:"):
        s = s.partition(",")[2]
    try:
        return base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        raise FaceImageError(INVALID_IMAGE, "The image data is not valid base64.") from None


def _sample_context(sample_id: int, user_id: int) -> str:
    return f"face_sample:{user_id}:{sample_id}"


def _profile_context(user_id: int, version: str) -> str:
    return f"face_profile:{user_id}:{version}"


def _sample_stats(db: Session, user_id: int) -> dict[str, int]:
    rows = db.execute(
        select(FaceSample.pose, func.count()).where(FaceSample.user_id == user_id).group_by(FaceSample.pose)
    ).all()
    return {pose: n for pose, n in rows}


def load_profile_payload(profile: FaceProfile, user_id: int, version: str) -> dict:
    """Decrypt a face profile: {"centroid": [...], "distance_threshold": float, ...}."""
    return json.loads(crypto.decrypt(profile.feature_data, _profile_context(user_id, version)))


def is_enrolled_in(profile: FaceProfile | None, model_row: ModelVersion) -> bool:
    return profile is not None and profile.model_version_id == model_row.id and profile.feature_data is not None


def _is_eligible(counts: dict[str, int]) -> bool:
    return sum(counts.values()) >= cfg.MIN_SAMPLES_PER_USER and len(counts) >= cfg.MIN_POSES_PER_USER


def active_profile(db: Session, user_id: int) -> FaceProfile | None:
    return db.scalar(select(FaceProfile).where(FaceProfile.user_id == user_id, FaceProfile.status == "active"))


def _eligible_rows(db: Session) -> dict[int, list[tuple[int, str]]]:
    """user_id -> [(sample_id, pose)] for users with enough varied samples."""
    by_user: dict[int, list[tuple[int, str]]] = defaultdict(list)
    for sid, uid, pose in db.execute(select(FaceSample.id, FaceSample.user_id, FaceSample.pose)).all():
        by_user[uid].append((sid, pose))
    return {
        uid: rows
        for uid, rows in by_user.items()
        if len(rows) >= cfg.MIN_SAMPLES_PER_USER and len({p for _, p in rows}) >= cfg.MIN_POSES_PER_USER
    }


def _fingerprint(eligible: dict[int, list[tuple[int, str]]]) -> str:
    items = sorted((uid, sid) for uid, rows in eligible.items() for sid, _ in rows)
    return hashlib.sha256(json.dumps(items).encode()).hexdigest()


# ---------------------------------------------------------------- enrollment


def enrollment_status(db: Session, user: User) -> dict:
    counts = _sample_stats(db, user.id)
    return {
        "poses": [
            {"pose": p, "instruction": text, "count": counts.get(p, 0), "target": cfg.SAMPLES_PER_POSE_TARGET}
            for p, text in cfg.POSES.items()
        ],
        "total_samples": sum(counts.values()),
        "distinct_poses": len(counts),
        "max_samples": cfg.MAX_SAMPLES_PER_USER,
        "min_samples_to_train": cfg.MIN_SAMPLES_PER_USER,
        "min_poses_to_train": cfg.MIN_POSES_PER_USER,
        "eligible": _is_eligible(counts),
        "has_profile": active_profile(db, user.id) is not None,
    }


def add_sample(db: Session, user: User, pose: str, image: bytes, detector: FaceDetector) -> dict:
    if pose not in cfg.POSES:
        raise FaceServiceError("UNKNOWN_POSE", f"Unknown pose. Use one of: {', '.join(cfg.POSES)}.", 422)
    counts = _sample_stats(db, user.id)
    if sum(counts.values()) >= cfg.MAX_SAMPLES_PER_USER:
        raise FaceServiceError("SAMPLE_LIMIT", "Sample limit reached. Delete your samples to start over.", 409)
    if counts.get(pose, 0) >= cfg.MAX_SAMPLES_PER_POSE:
        raise FaceServiceError("POSE_LIMIT", "Enough samples for this pose. Try another pose.", 409)

    face = extract_face(image, detector)  # raises FaceImageError
    sample = FaceSample(
        user_id=user.id,
        pose=pose,
        crop_encrypted=b"",
        sharpness=face.quality.sharpness,
        brightness=face.quality.brightness,
    )
    db.add(sample)
    db.flush()  # need the id to bind the ciphertext to this row
    sample.crop_encrypted = crypto.encrypt(face.crop.tobytes(), _sample_context(sample.id, user.id))
    db.commit()
    return {"accepted": True, "quality": face.quality.as_dict(), "enrollment": enrollment_status(db, user)}


def delete_user_face_data(db: Session, user: User) -> None:
    """Remove the user's samples and profile. A deployed model trained on them is retired."""
    profile = active_profile(db, user.id)
    db.execute(delete(FaceSample).where(FaceSample.user_id == user.id))
    if profile is not None and profile.model_version_id is not None:
        _retire_model(db, profile.model_version_id)
    db.execute(
        update(FaceProfile)
        .where(FaceProfile.user_id == user.id, FaceProfile.status == "active")
        .values(status="revoked", feature_data=None)
    )
    db.commit()
    registry.invalidate()


def _retire_model(db: Session, model_id: int) -> None:
    """Retire a model and revoke every profile that depended on it (they must retrain)."""
    db.execute(update(ModelVersion).where(ModelVersion.id == model_id, ModelVersion.status == "active").values(status="retired"))
    db.execute(
        update(FaceProfile)
        .where(FaceProfile.model_version_id == model_id, FaceProfile.status == "active")
        .values(status="revoked", feature_data=None)
    )


# ---------------------------------------------------------------- training


def _load_training_data(db: Session, eligible: dict[int, list[tuple[int, str]]]):
    pose_by_id = {sid: pose for rows in eligible.values() for sid, pose in rows}
    owner = {sid: uid for uid, rows in eligible.items() for sid, _ in rows}
    samples = db.scalars(select(FaceSample).where(FaceSample.id.in_(pose_by_id)).order_by(FaceSample.id)).all()
    size = cfg.IMAGE_SIZE
    crops = np.stack(
        [
            np.frombuffer(crypto.decrypt(s.crop_encrypted, _sample_context(s.id, s.user_id)), np.uint8).reshape(size, size)
            for s in samples
        ]
    )
    y = np.array([owner[s.id] for s in samples])
    groups = np.array([pose_by_id[s.id] for s in samples])
    return vectorize_many(crops), y, groups


def train(db: Session, user: User) -> dict:
    if not _train_lock.acquire(blocking=False):
        raise FaceServiceError("TRAINING_BUSY", "A training run is already in progress. Try again shortly.", 409)
    try:
        eligible = _eligible_rows(db)
        if user.id not in eligible:
            raise FaceServiceError(
                "NOT_ENOUGH_SAMPLES",
                f"Capture at least {cfg.MIN_SAMPLES_PER_USER} samples across {cfg.MIN_POSES_PER_USER}+ poses first.",
                422,
            )
        if len(eligible) < cfg.MIN_USERS_TO_TRAIN:
            raise FaceServiceError(
                "NOT_ENOUGH_USERS",
                "At least 2 enrolled users are required: LDA separates classes, so it needs 2 or more.",
                422,
            )
        X, y, groups = _load_training_data(db, eligible)
        try:
            results, chosen, scheme = compare_and_select(X, y, groups)
            model = FacePipeline(use_lda=True, classifier=chosen).fit(X, y)
        except InsufficientDataError as exc:
            raise FaceServiceError("NOT_ENOUGH_DATA", str(exc), 422) from exc

        deployed = results[f"pca_lda_{chosen}"]
        threshold = genuine_threshold(deployed["_genuine_distances"])
        fingerprint = _fingerprint(eligible)
        version = f"{datetime.now(UTC):%Y%m%d-%H%M%S}-{fingerprint[:6]}-{secrets.token_hex(2)}"
        info = model.describe()

        previous = registry.active_model_row(db)
        if previous is not None:
            _retire_model(db, previous.id)
            db.flush()
        row = ModelVersion(
            version=version,
            pca_config=info["pca"],
            lda_config=info["lda"],
            classifier=f"pca_lda_{chosen}",
            evaluation_metrics={
                "validation": scheme,
                "variants": strip_private(results),
                "distance_threshold": threshold,
                "threshold_percentile": cfg.DISTANCE_THRESHOLD_PERCENTILE,
                "scatter": scatter_analysis(model, X, y),
                "knn_k": info["knn_k"],
            },
            status="active",
            artifact=dump_model(model, version),
            n_samples=int(len(y)),
            n_classes=int(len(model.classes_)),
            dataset_fingerprint=fingerprint,
            library_versions=library_versions(),
        )
        db.add(row)
        db.flush()

        z = model.transform(X)
        for uid in model.classes_:
            uid = int(uid)
            mine = z[y == uid]
            payload = {
                "centroid": [float(v) for v in model.centroids_[uid]],
                "distance_threshold": threshold,
                "train_distance_mean": float(np.linalg.norm(mine - model.centroids_[uid], axis=1).mean()),
            }
            db.add(
                FaceProfile(
                    user_id=uid,
                    model_version_id=row.id,
                    feature_data=crypto.encrypt(json.dumps(payload).encode(), _profile_context(uid, version)),
                    sample_count=int((y == uid).sum()),
                    status="active",
                )
            )
        # older active profiles of these users belong to retired models and are already revoked
        db.commit()
        registry.invalidate()
        return model_summary(db, user)["model"]
    finally:
        _train_lock.release()


def model_summary(db: Session, user: User) -> dict:
    row = registry.active_model_row(db)
    if row is None:
        return {"model": None}
    metrics = row.evaluation_metrics or {}
    keys = ("accuracy", "macro_precision", "macro_recall", "macro_f1", "predict_ms_per_sample")
    comparison = {name: {k: v[k] for k in keys} for name, v in metrics.get("variants", {}).items()}
    profile = active_profile(db, user.id)
    return {
        "model": {
            "version": row.version,
            "trained_at": row.trained_at,
            "n_users": row.n_classes,
            "n_samples": row.n_samples,
            "classifier": row.classifier,
            "pca": row.pca_config,
            "lda": row.lda_config,
            "validation": metrics.get("validation", ""),
            "comparison": comparison,
            "distance_threshold": metrics.get("distance_threshold"),
            "includes_you": profile is not None and profile.model_version_id == row.id,
            "stale": _fingerprint(_eligible_rows(db)) != row.dataset_fingerprint,
        }
    }


# ---------------------------------------------------------------- recognition


def recognize(db: Session, user: User, image: bytes, detector: FaceDetector) -> dict:
    try:
        loaded = registry.load_active(db)
    except Exception as exc:  # ModelLoadError, crypto errors: not the user's fault
        raise FaceServiceError("MODEL_UNAVAILABLE", "The recognition model cannot be loaded. Retrain it.", 503) from exc
    if loaded is None:
        raise FaceServiceError("MODEL_NOT_TRAINED", "No model has been trained yet.", 409)
    row, model = loaded
    profile = active_profile(db, user.id)
    if profile is None or profile.model_version_id != row.id:
        raise FaceServiceError("NOT_IN_MODEL", "You are not part of the current model. Train it after enrolling.", 409)

    face = extract_face(image, detector)
    x = vectorize(face.crop)[None, :]
    z = model.transform(x)
    label = model.clf_.predict(z)[0]
    proba = model.predict_proba(x)[0]
    confidence = float(proba[list(model.classes_).index(label)])

    stored = load_profile_payload(profile, user.id, row.version)
    distance = float(np.linalg.norm(z[0] - np.array(stored["centroid"])))
    threshold = float(stored["distance_threshold"])

    is_you = int(label) == user.id
    if not is_you:
        reason = "WRONG_IDENTITY"
    elif distance > threshold:
        reason = "TOO_FAR_FROM_PROFILE"
    else:
        reason = "MATCH"
    return {
        "matched": reason == "MATCH",
        "reason": reason,
        "predicted_is_you": is_you,
        "user_id": user.id if is_you else None,  # never reveal another user's id
        "confidence": round(confidence, 4),
        "distance_to_you": round(distance, 4),
        "distance_threshold": round(threshold, 4),
        "model_version": row.version,
        "quality": face.quality.as_dict(),
    }
