"""Find a FacePay customer by pointing a camera at them, so a shop or a friend can send them a payment request.

This is IDENTIFICATION (who is this?), whereas payment authentication is VERIFICATION (is this the person who claims to be?).
It reads the trained model and the stored profiles but changes none of the recognition code: the same preprocessing, the same
PCA -> LDA -> classifier, the same per-person distance threshold and the same confidence floor are applied (through the same
`auth_policy.decide`). Liveness is not part of it, because finding someone pays nothing and moves nothing.

Why it is safe to ship:
* Only customers who switched on "Let shops and friends find me by face" can be found, everyone else is simply "no match".
* A match shows a name and a masked FacePay ID, nothing else. It is a ticket to send ONE request, not a way to pay.
* The person found is told (security log) and must approve any request with their own live face check and a confirmation.
* Scans are rate limited per requester, tickets are single use and expire in minutes, and no image, crop or vector is stored.
"""

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core import facepay_id as fid
from app.core.config import get_settings
from app.ml import config as cfg
from app.ml import embedding as emb
from app.ml import registry
from app.ml.preprocessing import FaceDetector, FaceImageError, decode_image, process_gray, vectorize
from app.ml.serialization import ModelLoadError
from app.models import FaceLookup, Merchant, User
from app.services import auth_policy as policy
from app.services import face_service
from app.services import security_service as sec

log = logging.getLogger("facepay.face")

MIN_USABLE_FRAMES = 2
MAX_FRAMES = 5

# What the person scanning is told when a frame is not usable. These describe the camera view only.
_CAMERA_MESSAGE = {
    "NO_FACE": "No face found. Hold the camera steady on one face, in good light.",
    "MULTIPLE_FACES": "More than one face is in view. Scan one person at a time.",
    "FACE_TOO_SMALL": "The face is too far away. Move closer.",
    "TOO_BLURRY": "The picture is blurry. Hold steady and try again.",
    "TOO_DARK": "It is too dark. Find more light and try again.",
    "TOO_BRIGHT": "It is too bright. Avoid strong light behind or on the face.",
    "INVALID_IMAGE": "The camera picture could not be read. Try again.",
    "IMAGE_TOO_LARGE": "The camera picture could not be read. Try again.",
}
NO_MATCH_MESSAGE = (
    "No FacePay customer found. They may not have turned on “find me by face”, or the scan was not clear enough. "
    "You can ask for their FacePay ID instead."
)


def _now() -> datetime:
    return datetime.now(UTC)


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class _Candidate:
    user: User
    confidence: float
    distance: float


def _miss(reason: str, message: str) -> dict:
    return {"matched": False, "reason": reason, "message": message, "lookup_token": None, "expires_in_seconds": None, "person": None}


def _candidate_or_refusal(user: User | None, confidence: float, distance: float, requester_user_id: int | None) -> tuple[_Candidate | None, str, str]:
    """A face has been recognised as `user`. Eligibility is checked only now and answered with the same "no match", so a refusal
    never says that a face belongs to a FacePay customer who has not opted in."""
    if user is None or user.status != "active" or not user.face_lookup_enabled or not user.biometric_payments_enabled:
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    if requester_user_id is not None and user.id == requester_user_id:
        return None, "SELF", "That is your own face. Point the camera at the person you are asking."
    return _Candidate(user, confidence, distance), "MATCH", ""


def _identify_embedding(db: Session, grays: list[np.ndarray], requester_user_id: int | None) -> tuple[_Candidate | None, str, str]:
    """1:N with deep embeddings: the nearest enrolled customer wins only if every frame agrees, they are close enough, and they beat
    the runner-up clearly. The search covers EVERY enrolled customer (opted in or not), so a stranger who resembles a customer who
    opted in cannot be mistaken for the one who did not."""
    profiles = face_service.embedding_profiles(db)
    if not profiles:
        raise _err(503, "LOOKUP_UNAVAILABLE", "Finding people by face is not available yet. Customers need to finish face setup first.")
    ids = list(profiles)
    templates = np.stack([np.asarray(profiles[i]["template"], np.float64) for i in ids])
    vectors, first_error = [], None
    for gray in grays:
        try:
            vectors.append(emb.get_embedder().embed(gray, second_face_ratio=cfg.AUTH_SECOND_FACE_RATIO))
        except FaceImageError as exc:
            first_error = first_error or exc.code
        except emb.EmbeddingUnavailable:
            raise _err(503, "LOOKUP_UNAVAILABLE", "Finding people by face is temporarily unavailable.") from None
    if len(vectors) < MIN_USABLE_FRAMES:
        code = first_error or "NO_FACE"
        return None, "CAMERA_" + code, _CAMERA_MESSAGE.get(code, _CAMERA_MESSAGE["NO_FACE"])
    frames = np.stack(vectors).astype(np.float64)
    dist = np.linalg.norm(frames[:, None, :] - templates[None, :, :], axis=2)  # frames x customers
    nearest = dist.argmin(axis=1)
    if len(set(nearest.tolist())) != 1:  # the frames disagree about who it is
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    j = int(nearest[0])
    mine = dist[:, j]
    mean_d = float(mine.mean())
    runner_up = float(np.delete(dist.mean(axis=0), j).min()) if len(ids) > 1 else float("inf")
    log.info("lookup(embedding) frames=%d customers=%d mean_distance=%.3f margin=%s", len(vectors), len(ids), mean_d, "n/a" if runner_up == float("inf") else round(runner_up - mean_d, 3))
    if mean_d > cfg.EMBED_LOOKUP_THRESHOLD or float(mine.max()) > cfg.EMBED_FRAME_CAP * cfg.EMBED_LOOKUP_THRESHOLD or runner_up - mean_d < cfg.EMBED_LOOKUP_MARGIN:
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    return _candidate_or_refusal(db.get(User, ids[j]), emb.score(mean_d, cfg.EMBED_LOOKUP_THRESHOLD), mean_d, requester_user_id)


def _identify(db: Session, grays: list[np.ndarray], detector: FaceDetector, requester_user_id: int | None) -> tuple[_Candidate | None, str, str]:
    """(candidate, reason, message). candidate is None unless the scan is accepted."""
    if face_service.embedding_mode():
        return _identify_embedding(db, grays, requester_user_id)
    try:
        loaded = registry.load_active(db)
    except ModelLoadError:
        log.warning("face lookup: model could not be loaded")
        loaded = None
    if loaded is None:
        raise _err(
            503, "LOOKUP_UNAVAILABLE",
            "Finding people by face is not available yet. At least two customers need to finish face setup first.",
        )
    row, model = loaded

    crops, first_error = [], None
    for gray in grays:
        try:
            crops.append(process_gray(gray, detector, second_face_ratio=cfg.AUTH_SECOND_FACE_RATIO).crop)
        except FaceImageError as exc:
            first_error = first_error or exc.code
    if len(crops) < MIN_USABLE_FRAMES:
        code = first_error or "NO_FACE"
        return None, "CAMERA_" + code, _CAMERA_MESSAGE.get(code, _CAMERA_MESSAGE["NO_FACE"])

    labels, confidences, zs = [], [], []
    classes = list(model.classes_)
    for crop in crops:
        x = vectorize(crop)[None, :]
        z = model.transform(x)
        label = int(model.clf_.predict(z)[0])
        labels.append(label)
        confidences.append(float(model.predict_proba(x)[0][classes.index(label)]))
        zs.append(z[0])
    if len(set(labels)) != 1:  # the frames disagree about who it is: not a clear identification
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    uid = labels[0]

    user = db.get(User, uid)
    profile = face_service.active_profile(db, uid)
    if user is None or profile is None or not face_service.is_enrolled_in(profile, row):
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    try:
        payload = face_service.load_profile_payload(profile, uid, row.version)
    except Exception:  # an unreadable profile is a server problem, never a "match" and never an identity leak
        log.warning("face lookup: a stored profile could not be read")
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    centroid, threshold = np.array(payload["centroid"]), float(payload["distance_threshold"])
    distances = [float(np.linalg.norm(z - centroid)) for z in zs]

    # The very same acceptance rule as payment authentication (confidence floor, mean distance within the person's own
    # threshold, no single frame beyond the cap), minus liveness.
    decision = policy.decide(policy.Evidence(
        frames=tuple(policy.FrameIdentity(True, c, d) for c, d in zip(confidences, distances, strict=True)),
        distance_threshold=threshold, liveness_passed=True,
    ))
    log.info("lookup frames=%d accepted=%s", len(crops), decision.authenticated)
    if not decision.authenticated:
        return None, "NO_MATCH", NO_MATCH_MESSAGE
    return _candidate_or_refusal(user, min(confidences), max(distances), requester_user_id)


def lookup(
    db: Session, frames_b64: list[str], detector: FaceDetector, *, requester_user: User | None = None, requester_merchant: Merchant | None = None
) -> dict:
    """Scan result for the requester. On a match: a single-use ticket plus the name and masked ID to confirm."""
    if (requester_user is None) == (requester_merchant is None):
        raise ValueError("exactly one requester")
    grays = []
    for f in frames_b64[:MAX_FRAMES]:
        try:
            grays.append(decode_image(face_service.decode_upload(f)))
        except FaceImageError:
            continue
    if len(grays) < MIN_USABLE_FRAMES:
        return _miss("CAMERA_INVALID_IMAGE", _CAMERA_MESSAGE["INVALID_IMAGE"])
    face_service.schedule_retrain(db)  # same housekeeping as a face check: an out-of-date model is rebuilt in the background
    candidate, reason, message = _identify(db, grays, detector, requester_user.id if requester_user else None)
    if candidate is None:
        return _miss(reason, message)

    ttl = get_settings().face_lookup_ttl_seconds
    db.execute(delete(FaceLookup).where(FaceLookup.expires_at < _now() - timedelta(days=1)))  # housekeeping: old tickets are useless
    token = "fl_" + secrets.token_urlsafe(24)
    db.add(FaceLookup(
        token_hash=_hash(token),
        requester_user_id=requester_user.id if requester_user else None,
        requester_merchant_id=requester_merchant.id if requester_merchant else None,
        target_user_id=candidate.user.id,
        expires_at=_now() + timedelta(seconds=ttl),
    ))
    sec.record_event(db, candidate.user, "FACE_LOOKUP_MATCH")  # the person found can see that someone scanned them
    db.commit()
    return {
        "matched": True, "reason": "MATCH", "message": None, "lookup_token": token, "expires_in_seconds": ttl,
        "person": {"display_name": candidate.user.name, "masked_id": fid.mask(candidate.user.facepay_id)},
    }


def redeem(db: Session, token: str, *, requester_user: User | None = None, requester_merchant: Merchant | None = None) -> User:
    """Spends a ticket and returns the customer it points at. The change is part of the caller's transaction: if what the
    caller does next fails, the ticket is NOT spent and the requester can fix the details and try again within its lifetime.

    A ticket that does not exist, belongs to someone else or was already used looks the same: 404."""
    row = db.scalar(select(FaceLookup).where(FaceLookup.token_hash == _hash(token or "")).with_for_update())
    mine = row is not None and (
        (requester_user is not None and row.requester_user_id == requester_user.id)
        or (requester_merchant is not None and row.requester_merchant_id == requester_merchant.id)
    )
    if not mine or row.consumed_at is not None:
        db.rollback()
        raise _err(404, "LOOKUP_NOT_FOUND", "That scan can no longer be used. Scan their face again.")
    if row.expires_at <= _now():
        db.rollback()
        raise _err(410, "LOOKUP_EXPIRED", "That scan has expired. Scan their face again.")
    target = db.get(User, row.target_user_id)
    if target is None or target.status != "active" or not target.face_lookup_enabled:
        db.rollback()
        raise _err(409, "LOOKUP_UNAVAILABLE", "That person can no longer be asked this way. Use their FacePay ID instead.")
    row.consumed_at = _now()
    return target
