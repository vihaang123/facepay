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
import logging
import secrets
import threading
from collections import defaultdict
from datetime import UTC, datetime

import cv2
import numpy as np
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import SQLAlchemyError
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
    decode_image,
    extract_face,
    process_gray,
    vectorize,
    vectorize_many,
)
from app.ml.serialization import ModelLoadError, dump_model, library_versions
from app.models import FaceProfile, FaceSample, ModelVersion, User
from app.services import security_service as sec


log = logging.getLogger("facepay.face")  # restricted server log: codes, ids and versions only, never images, vectors or keys


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


def guided_progress(counts: dict[str, int]) -> dict:
    """Where the guided flow stands, from stored sample counts only (so it resumes after a reload or a new device)."""
    target = cfg.GUIDED_SAMPLES_PER_POSE
    sequence = [{"pose": p, "instruction": cfg.POSES[p], "count": counts.get(p, 0), "target": target} for p in cfg.GUIDED_SEQUENCE]
    captured = sum(min(item["count"], target) for item in sequence)
    next_pose = next((item["pose"] for item in sequence if item["count"] < target), None)
    return {"sequence": sequence, "captured": captured, "required": target * len(sequence), "next_pose": next_pose, "complete": next_pose is None}


def enrollment_status(db: Session, user: User) -> dict:
    counts = _sample_stats(db, user.id)
    return {
        "guided": guided_progress(counts),
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


def _is_duplicate(db: Session, user: User, crop: np.ndarray) -> bool:
    """True if the new crop is (almost) pixel-identical to a sample this user already stored: a frozen, repeated or
    replayed frame. Compared on the same equalised 64x64 crops that are stored (decrypted here, never returned)."""
    size = cfg.IMAGE_SIZE
    new = crop.astype(np.int16)
    for sample in db.scalars(select(FaceSample).where(FaceSample.user_id == user.id)):
        old = np.frombuffer(crypto.decrypt(sample.crop_encrypted, _sample_context(sample.id, user.id)), np.uint8).reshape(size, size)
        if float(np.abs(new - old.astype(np.int16)).mean()) < cfg.DUPLICATE_MAX_MEAN_DIFF:
            return True
    return False


def add_sample(db: Session, user: User, pose: str, image: bytes, detector: FaceDetector) -> dict:
    """The server alone decides whether a frame is acceptable: single face, size, brightness, sharpness (extract_face),
    not a duplicate, and within the sample limits. The client's own checks are only guidance."""
    if pose not in cfg.POSES:
        raise FaceServiceError("UNKNOWN_POSE", f"Unknown pose. Use one of: {', '.join(cfg.POSES)}.", 422)
    counts = _sample_stats(db, user.id)
    if sum(counts.values()) >= cfg.MAX_SAMPLES_PER_USER:
        raise FaceServiceError("SAMPLE_LIMIT", "Sample limit reached. Delete your samples to start over.", 409)
    if counts.get(pose, 0) >= cfg.MAX_SAMPLES_PER_POSE:
        raise FaceServiceError("POSE_LIMIT", "Enough samples for this pose. Try another pose.", 409)

    face = extract_face(image, detector)  # raises FaceImageError
    if _is_duplicate(db, user, face.crop):
        raise FaceServiceError("DUPLICATE_SAMPLE", "That frame is almost identical to one already captured. Move slightly and hold still again.", 409)
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
    status = enrollment_status(db, user)
    guided = status["guided"]
    return {
        "accepted": True,
        "quality": face.quality.as_dict(),
        "next_pose": guided["next_pose"],
        "progress": {"captured": guided["captured"], "required": guided["required"]},
        "enrollment": status,
    }


def assess_frame(image: bytes, detector: FaceDetector) -> dict:
    """Live feedback for guided capture: what the server's own checks would say about this frame, plus where the face
    is. Stores nothing. Acceptance is decided only by add_sample."""
    gray = decode_image(image)
    h, w = gray.shape
    scale = cfg.DETECTION_MAX_SIDE / max(h, w)
    small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else gray
    sh, sw = small.shape
    boxes = sorted(detector.detect(small), key=lambda b: b.area, reverse=True)
    significant = [b for b in boxes if boxes and b.area >= cfg.SECOND_FACE_RATIO * boxes[0].area]
    face = None
    if boxes:
        b = boxes[0]
        face = {"cx": round((b.x + b.w / 2) / sw, 4), "cy": round((b.y + b.h / 2) / sh, 4), "width": round(b.w / sw, 4), "height": round(b.h / sh, 4)}
    try:
        process_gray(gray, detector)
        state = "OK"
    except FaceImageError as exc:
        state = {"NO_FACE": "NO_FACE", "MULTIPLE_FACES": "MULTIPLE_FACES", "FACE_TOO_SMALL": "FACE_TOO_SMALL", "TOO_DARK": "TOO_DARK",
                 "TOO_BRIGHT": "TOO_BRIGHT", "TOO_BLURRY": "TOO_BLURRY"}.get(exc.code, "INVALID_IMAGE")
    return {"state": state, "faces": len(significant), "face": face}


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
    sec.record_event(db, user, "FACE_DATA_REMOVED")
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
        try:
            X, y, groups = _load_training_data(db, eligible)
        except crypto.BiometricCryptoError as exc:
            log.warning("training stopped: stored face samples cannot be decrypted user_id=%s", user.id)
            raise FaceServiceError("BIOMETRIC_DECRYPTION_FAILED", "Stored face data could not be read, so the model cannot be trained.", 503) from exc
        try:
            results, chosen, scheme = compare_and_select(X, y, groups)
            model = FacePipeline(use_lda=True, classifier=chosen).fit(X, y)
        except InsufficientDataError as exc:
            raise FaceServiceError("NOT_ENOUGH_DATA", str(exc), 422) from exc
        except Exception as exc:  # numerical or library failure while fitting: nothing has been changed yet
            log.exception("training failed while fitting user_id=%s", user.id)
            raise FaceServiceError("TRAINING_FAILED", "Training did not complete. Your previous model, if any, is unchanged. Try again.", 500) from exc

        deployed = results[f"pca_lda_{chosen}"]
        threshold = genuine_threshold(deployed["_genuine_distances"])
        fingerprint = _fingerprint(eligible)
        version = f"{datetime.now(UTC):%Y%m%d-%H%M%S}-{fingerprint[:6]}-{secrets.token_hex(2)}"
        info = model.describe()

        try:
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
        except Exception:  # the old model must stay active if anything fails while the new one is written
            db.rollback()
            registry.invalidate()
            log.exception("training failed while saving the model user_id=%s", user.id)
            raise
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



# ---------------------------------------------------------------- is a face check possible right now?

# Why recognition cannot run, as a safe code, the sentence shown to the customer, what they can do about it, and the
# HTTP status for API callers. None of these says anything about the person's face: nothing was decided about it.
_NOT_READY_COPY = "Face recognition is temporarily unavailable because the recognition model is not ready."
MODEL_ISSUES: dict[str, tuple[str, str, int]] = {
    "ENROLLMENT_INSUFFICIENT": ("Your face setup is not finished. Capture the remaining face samples first.", "ENROLL", 409),
    "INSUFFICIENT_IDENTITIES": (
        "The recognition model needs at least two people with a finished face setup before it can be trained. "
        "Another person has to complete their own face setup on their own account.",
        "WAIT_FOR_SECOND_PERSON", 409),
    "MODEL_NOT_TRAINED": (f"{_NOT_READY_COPY} It has not been trained yet.", "TRAIN", 409),
    "MODEL_NOT_FOUND": (f"{_NOT_READY_COPY} Your face profile points to a model that is no longer active.", "TRAIN", 409),
    "MODEL_STALE": (f"{_NOT_READY_COPY} Your latest face samples are not part of it yet.", "TRAIN", 409),
    "MODEL_VERSION_INCOMPATIBLE": (f"{_NOT_READY_COPY} It was trained with different software and must be trained again.", "TRAIN", 503),
    "MODEL_LOAD_FAILED": (f"{_NOT_READY_COPY} It could not be loaded.", "TRAIN", 503),
    "BIOMETRIC_DECRYPTION_FAILED": (f"{_NOT_READY_COPY} Stored face data could not be read.", "CONTACT_ADMIN", 503),
}
_LOAD_KIND_CODE = {"VERSION_MISMATCH": "MODEL_VERSION_INCOMPATIBLE", "DECRYPT": "BIOMETRIC_DECRYPTION_FAILED", "CORRUPT": "MODEL_LOAD_FAILED", "TYPE": "MODEL_LOAD_FAILED"}
# Cases a person can fix themselves are routine; the rest mean something is wrong on the server and are logged as warnings.
_TECHNICAL = {"MODEL_VERSION_INCOMPATIBLE", "MODEL_LOAD_FAILED", "BIOMETRIC_DECRYPTION_FAILED", "MODEL_NOT_FOUND"}


class ModelState:
    """The answer to "can this customer be recognised right now, and if not, exactly why?"."""

    def __init__(self, code=None, row=None, model=None, profile=None, payload=None, stale=False, facts=None):
        self.code, self.row, self.model, self.profile, self.payload = code, row, model, profile, payload
        self.stale, self.facts = stale, facts or {}

    @property
    def ready(self) -> bool:
        return self.code is None

    @property
    def message(self) -> str:
        return "" if self.ready else MODEL_ISSUES[self.code][0]

    @property
    def next_action(self) -> str | None:
        return None if self.ready else MODEL_ISSUES[self.code][1]

    @property
    def http_status(self) -> int:
        return 200 if self.ready else MODEL_ISSUES[self.code][2]


def inspect_model(db: Session, user: User) -> ModelState:
    """Looks at the enrolment, the active model and this customer's profile, and says which one is the problem.
    Database errors are NOT converted into a model problem: they propagate and surface as a server error."""
    counts = _sample_stats(db, user.id)
    own_ok = _is_eligible(counts)
    eligible = _eligible_rows(db)
    row = registry.active_model_row(db)
    profile = active_profile(db, user.id)
    facts = {
        "your_samples": sum(counts.values()), "required_samples": cfg.MIN_SAMPLES_PER_USER,
        "your_poses": len(counts), "required_poses": cfg.MIN_POSES_PER_USER,
        "people_ready": len(eligible), "people_required": cfg.MIN_USERS_TO_TRAIN,
        "model_active": row is not None, "in_model": bool(row is not None and is_enrolled_in(profile, row)),
    }

    def fail(code: str, cause: str | None = None) -> ModelState:
        level = logging.WARNING if code in _TECHNICAL else logging.INFO
        log.log(level, "face model not ready user_id=%s code=%s model_version=%s cause=%s facts=%s",
                user.id, code, row.version if row is not None else None, cause, facts)
        return ModelState(code, row=row, profile=profile, facts=facts)

    if row is None:
        if profile is not None:  # an active profile with no active model should not exist
            return fail("MODEL_NOT_FOUND")
        if not own_ok:
            return fail("ENROLLMENT_INSUFFICIENT")
        if len(eligible) < cfg.MIN_USERS_TO_TRAIN:
            return fail("INSUFFICIENT_IDENTITIES")
        return fail("MODEL_NOT_TRAINED")

    if not is_enrolled_in(profile, row):
        return fail("ENROLLMENT_INSUFFICIENT" if not own_ok else "MODEL_STALE")

    try:
        loaded = registry.load_active(db)
        assert loaded is not None
        model = loaded[1]
        payload = load_profile_payload(profile, user.id, row.version)
    except SQLAlchemyError:
        raise
    except ModelLoadError as exc:
        return fail(_LOAD_KIND_CODE.get(exc.kind, "MODEL_LOAD_FAILED"), cause=f"{exc.kind}")
    except crypto.BiometricCryptoError:
        return fail("BIOMETRIC_DECRYPTION_FAILED", cause="profile")
    except Exception as exc:  # unexpected: record the type only
        return fail("MODEL_LOAD_FAILED", cause=type(exc).__name__)

    stale = _fingerprint(eligible) != row.dataset_fingerprint
    return ModelState(None, row=row, model=model, profile=profile, payload=payload, stale=stale, facts=facts)


def readiness(db: Session, user: User) -> dict:
    """The customer-facing readiness report. Counts only; no model internals, scores or other people's identities."""
    state = inspect_model(db, user)
    f = state.facts
    return {
        "ready": state.ready,
        "code": state.code,
        "message": state.message or "Face recognition is ready.",
        "next_action": state.next_action,
        "stale": state.stale,
        "model_version": state.row.version if state.row is not None else None,
        "checks": {
            "samples": {"have": f["your_samples"], "need": f["required_samples"]},
            "poses": {"have": f["your_poses"], "need": f["required_poses"]},
            "people_with_finished_setup": {"enough": f["people_ready"] >= f["people_required"]},
            "model_active": f["model_active"],
            "you_are_in_model": f["in_model"],
        },
    }

# ---------------------------------------------------------------- recognition


def recognize(db: Session, user: User, image: bytes, detector: FaceDetector) -> dict:
    state = inspect_model(db, user)
    if not state.ready:
        raise FaceServiceError(state.code, state.message, state.http_status)
    row, model = state.row, state.model

    face = extract_face(image, detector)
    x = vectorize(face.crop)[None, :]
    z = model.transform(x)
    label = model.clf_.predict(z)[0]
    proba = model.predict_proba(x)[0]
    confidence = float(proba[list(model.classes_).index(label)])

    stored = state.payload
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
