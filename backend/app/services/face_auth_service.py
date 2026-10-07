"""Face authentication: challenge -> frames -> PCA/LDA identity + liveness -> policy -> log.

Reuses the Phase 3 pipeline unchanged (preprocessing, FacePipeline, encrypted face profile).
Never returns or stores images, crops or feature vectors; the log holds metadata only.
"""

import secrets
from datetime import UTC, datetime, timedelta

import numpy as np
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ml import config as cfg
from app.ml import liveness, registry
from app.ml.preprocessing import FaceDetector, FaceImageError, decode_image, process_gray, vectorize
from app.models import AuthenticationLog, FaceAuthChallenge, User
from app.services import auth_policy as policy
from app.services.face_service import active_profile, decode_upload, is_enrolled_in, load_profile_payload


def issue_challenge(db: Session, user: User) -> dict:
    now = datetime.now(UTC)
    db.execute(  # housekeeping: old challenges are useless
        delete(FaceAuthChallenge).where(FaceAuthChallenge.user_id == user.id, FaceAuthChallenge.expires_at < now - timedelta(days=1))
    )
    name = secrets.choice(sorted(cfg.CHALLENGES))
    row = FaceAuthChallenge(
        token=secrets.token_urlsafe(32),
        user_id=user.id,
        challenge=name,
        expires_at=now + timedelta(seconds=cfg.CHALLENGE_TTL_SECONDS),
    )
    db.add(row)
    db.commit()
    return {
        "challenge_id": row.token,
        "challenge": name,
        "instruction": cfg.CHALLENGES[name],
        "expires_in_seconds": cfg.CHALLENGE_TTL_SECONDS,
        "baseline_frames": cfg.AUTH_BASELINE_FRAMES,
        "min_frames": cfg.AUTH_MIN_FRAMES,
        "max_frames": cfg.AUTH_MAX_FRAMES,
    }


def _consume_challenge(db: Session, user: User, token: str) -> tuple[str, str | None]:
    """Single use: the challenge is spent whether or not the attempt succeeds."""
    row = db.scalar(
        select(FaceAuthChallenge).where(FaceAuthChallenge.token == token, FaceAuthChallenge.user_id == user.id).with_for_update()
    )
    if row is None or row.consumed_at is not None:
        db.rollback()
        return "INVALID", None  # unknown, someone else's and already-used look identical
    now = datetime.now(UTC)
    row.consumed_at = now
    expired = row.expires_at <= now
    name = row.challenge
    db.commit()
    return ("EXPIRED" if expired else "OK"), name


def _log(db: Session, user: User, decision: policy.Decision, *, challenge, liveness_result, frames, distance_threshold, model_version) -> AuthenticationLog:
    entry = AuthenticationLog(
        user_id=user.id,
        result="SUCCESS" if decision.authenticated else "FAILED",
        confidence=min((f.confidence for f in frames), default=None),
        distance=max((f.distance for f in frames), default=None),
        liveness_result=liveness_result,
        failure_reason=decision.reason,
        failure_detail=decision.detail,
        challenge=challenge,
        model_version=model_version,
    )
    db.add(entry)
    db.commit()
    return entry


def _stages(ev: policy.Evidence, decision: policy.Decision, liveness_result: str) -> list[dict]:
    pre_image = decision.reason in ("ACCOUNT_DISABLED", "CHALLENGE_INVALID", "CHALLENGE_EXPIRED", "MODEL_UNAVAILABLE", "NOT_ENROLLED")
    face_ok = None if pre_image else (ev.image_reason is None)
    live = {"PASSED": "PASSED", "FAILED": "FAILED"}.get(liveness_result, "SKIPPED")
    identity_reached = (not pre_image) and ev.image_reason is None and ev.liveness_passed is True
    if not identity_reached:
        ident = "SKIPPED"
    else:
        ident = "PASSED" if decision.authenticated else "FAILED"
    return [
        {"stage": "FACE_DETECTION", "status": "SKIPPED" if face_ok is None else ("PASSED" if face_ok else "FAILED")},
        {"stage": "LIVENESS", "status": live},
        {"stage": "IDENTITY", "status": ident},
    ]


def authenticate(db: Session, user: User, token: str, frames_b64: list[str], detector: FaceDetector) -> dict:
    ctx = dict(challenge=None, liveness_result=liveness.NOT_EVALUATED, frames=(), distance_threshold=None, model_version=None)
    ev = policy.Evidence()

    def finish(evidence: policy.Evidence) -> dict:
        decision = policy.decide(evidence)
        entry = _log(db, user, decision, **ctx)
        reached = evidence.liveness_passed is True and evidence.image_reason is None and decision.reason not in (
            "ACCOUNT_DISABLED", "CHALLENGE_INVALID", "CHALLENGE_EXPIRED", "MODEL_UNAVAILABLE", "NOT_ENROLLED")
        identity = None
        if reached and evidence.frames:
            identity = {
                "verified": decision.authenticated,
                "confidence": round(entry.confidence, 4),
                "distance": round(entry.distance, 4),
                "distance_threshold": round(evidence.distance_threshold, 4),
                "frames_evaluated": len(evidence.frames),
                "name": user.name if decision.authenticated else None,
            }
        return {
            "result": decision.result,
            "reason": decision.reason,
            "detail": decision.detail,
            "authentication_id": entry.id,
            "stages": _stages(evidence, decision, ctx["liveness_result"]),
            "liveness": ctx["liveness_result"],
            "challenge": ctx["challenge"],
            "identity": identity,
            "model_version": ctx["model_version"],
        }

    try:
        if user.status != "active":
            return finish(policy.Evidence(account_active=False))

        status, challenge = _consume_challenge(db, user, token)
        ctx["challenge"] = challenge
        if status != "OK":
            return finish(policy.Evidence(challenge=status))

        try:
            loaded = registry.load_active(db)
        except Exception:
            loaded = None
        if loaded is None:
            return finish(policy.Evidence(model_available=False))
        row, model = loaded
        ctx["model_version"] = row.version
        profile = active_profile(db, user.id)
        if not is_enrolled_in(profile, row):
            return finish(policy.Evidence(enrolled=False))
        stored = load_profile_payload(profile, user.id, row.version)
        centroid, threshold = np.array(stored["centroid"]), float(stored["distance_threshold"])
        ctx["distance_threshold"] = threshold

        # --- decode + detect every frame
        try:
            grays = [decode_image(decode_upload(f)) for f in frames_b64]
        except FaceImageError as exc:
            return finish(policy.Evidence(image_reason=policy.IMAGE_ERROR_REASON[exc.code], distance_threshold=threshold))
        observations = [liveness.observe(g, detector) for g in grays]
        if any(o.faces > 1 for o in observations):
            return finish(policy.Evidence(image_reason=policy.IMAGE_ERROR_REASON["MULTIPLE_FACES"], distance_threshold=threshold))
        if any(o.faces == 0 for o in observations[: cfg.AUTH_BASELINE_FRAMES]):
            return finish(policy.Evidence(image_reason=policy.IMAGE_ERROR_REASON["NO_FACE"], distance_threshold=threshold))

        # --- identity on the baseline frames (full Phase 3 preprocessing + quality gates)
        identities = []
        for g in grays[: cfg.AUTH_BASELINE_FRAMES]:
            try:
                face = process_gray(g, detector, second_face_ratio=cfg.AUTH_SECOND_FACE_RATIO)
            except FaceImageError as exc:
                return finish(policy.Evidence(image_reason=policy.IMAGE_ERROR_REASON[exc.code], distance_threshold=threshold))
            x = vectorize(face.crop)[None, :]
            z = model.transform(x)
            label = model.clf_.predict(z)[0]
            proba = model.predict_proba(x)[0]
            mine = float(proba[list(model.classes_).index(user.id)])  # score of YOUR class only
            identities.append(
                policy.FrameIdentity(
                    predicted_is_user=int(label) == user.id,
                    confidence=mine,
                    distance=float(np.linalg.norm(z[0] - centroid)),
                )
            )
        ctx["frames"] = tuple(identities)

        # --- liveness
        verdict = liveness.evaluate(ctx["challenge"], observations)
        ctx["liveness_result"] = verdict.result
        return finish(
            policy.Evidence(
                liveness_passed=verdict.passed,
                liveness_detail=verdict.detail,
                frames=tuple(identities),
                distance_threshold=threshold,
            )
        )
    except Exception:
        db.rollback()
        _log(db, user, policy.Decision(False, "INTERNAL_ERROR"), **ctx)
        raise


def list_attempts(db: Session, user: User, limit: int = 10) -> list[AuthenticationLog]:
    return list(
        db.scalars(
            select(AuthenticationLog).where(AuthenticationLog.user_id == user.id).order_by(AuthenticationLog.id.desc()).limit(limit)
        )
    )
