"""Face authentication against the real PostgreSQL test database: challenge -> frames -> PCA/LDA identity
+ liveness -> policy -> log. Synthetic scenes (see synthetic_scenes.py) stand in for webcam frames."""

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.api import faces as faces_api
from app.core import crypto
from app.main import app
from app.ml import config as cfg
from app.models import AuthenticationLog, FaceAuthChallenge, FaceProfile, ModelVersion, User
from tests.conftest import STRONG_PASSWORD, unique_email
from tests.synthetic_scenes import GOOD_TURN, BackgroundBoxDetector, blurry_scene, empty_scene, scene, sequence

POSES = list(cfg.POSES)


@pytest.fixture(autouse=True)
def scene_detector():
    app.dependency_overrides[faces_api.get_detector] = lambda: BackgroundBoxDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def new_customer(client, name="Test Customer"):
    email = unique_email("c")
    r = client.post("/auth/register", json={"name": name, "email": email, "password": STRONG_PASSWORD})
    assert r.status_code == 201
    tok = client.post("/auth/login", json={"email": email, "password": STRONG_PASSWORD}).json()["access_token"]
    return {"id": r.json()["id"], "name": name, "headers": {"Authorization": f"Bearer {tok}"}}


def enroll(client, cust, identity, n=12):
    for i in range(n):
        r = client.post("/faces/samples", json={"image_base64": b64(scene(identity, i, x=120 + (i * 13) % 80)), "pose": POSES[i % 4]},
                        headers=cust["headers"])
        assert r.status_code == 201, r.text


def set_threshold(db, user_ids, value):
    """Rewrite the distance threshold inside the encrypted face profiles (as a re-enrolment would store it)."""
    for uid in user_ids:
        prof = db.scalar(select(FaceProfile).where(FaceProfile.user_id == uid, FaceProfile.status == "active"))
        version = db.scalar(select(ModelVersion.version).where(ModelVersion.id == prof.model_version_id))
        ctx = f"face_profile:{uid}:{version}"
        data = json.loads(crypto.decrypt(prof.feature_data, ctx))
        data["distance_threshold"] = value
        prof.feature_data = crypto.encrypt(json.dumps(data).encode(), ctx)
    db.commit()


@pytest.fixture
def trained_calibrated(client):
    """Two users trained through the API with the threshold exactly as training computed it (percentile 70
    of out-of-fold genuine distances, so ~30% of genuine frames are over it BY DESIGN)."""
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll(client, a, 0)
    enroll(client, b, 1)
    r = client.post("/faces/train", headers=a["headers"])
    assert r.status_code == 200, r.text
    return a, b


@pytest.fixture
def trained(trained_calibrated, db):
    """Same, but with a generous distance threshold so the tests of liveness, challenge handling, face
    detection and logging do not depend on which synthetic frames happen to fall over the 70th-percentile
    cut-off. The threshold behaviour itself is tested separately (calibrated / tiny threshold)."""
    a, b = trained_calibrated
    set_threshold(db, [a["id"], b["id"]], 1000.0)
    return a, b


def get_challenge(client, cust):
    r = client.post("/face-auth/challenge", headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def verify(client, cust, challenge_id, frames):
    return client.post("/face-auth/verify", json={"challenge_id": challenge_id, "frames": [b64(f) for f in frames]}, headers=cust["headers"])


def attempt(client, cust, identity, moves=GOOD_TURN, **kw):
    ch = get_challenge(client, cust)
    r = verify(client, cust, ch["challenge_id"], sequence(identity, ch["challenge"], moves, **kw))
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------ challenge endpoint


def test_challenge_is_random_single_user_and_documented(client, customer):
    seen = set()
    for _ in range(30):
        c = get_challenge(client, customer)
        seen.add(c["challenge"])
        assert c["challenge"] in cfg.CHALLENGES and c["instruction"] == cfg.CHALLENGES[c["challenge"]]
        assert c["expires_in_seconds"] == cfg.CHALLENGE_TTL_SECONDS and len(c["challenge_id"]) >= 32
    assert seen == set(cfg.CHALLENGES)  # both directions get issued (2^-29 chance of a flaky miss)


def test_face_auth_requires_customer_token(client, merchant):
    assert client.post("/face-auth/challenge").status_code == 401
    assert client.post("/face-auth/verify", json={}).status_code == 401
    assert client.get("/face-auth/attempts").status_code == 401
    assert client.post("/face-auth/challenge", headers=merchant["headers"]).status_code == 403
    assert client.post("/face-auth/verify", json={}, headers=merchant["headers"]).status_code == 403


# ------------------------------------------------------------ success path


def test_correct_user_with_completed_challenge_is_authenticated_and_logged(client, trained, db):
    a, b = trained
    res = attempt(client, a, identity=0)
    assert res["result"] == "AUTHENTICATED" and res["reason"] is None
    assert res["liveness"] == "PASSED"
    assert [s["status"] for s in res["stages"]] == ["PASSED", "PASSED", "PASSED"]
    ident = res["identity"]
    assert ident["verified"] and ident["name"] == "Asha Rao" and ident["frames_evaluated"] == cfg.AUTH_BASELINE_FRAMES
    assert 0.5 <= ident["confidence"] <= 1 and ident["distance"] <= ident["distance_threshold"]
    log = db.get(AuthenticationLog, res["authentication_id"])
    assert (log.user_id, log.result, log.liveness_result, log.failure_reason) == (a["id"], "SUCCESS", "PASSED", None)
    assert log.confidence == pytest.approx(ident["confidence"], abs=1e-4) and log.distance == pytest.approx(ident["distance"], abs=1e-4)
    assert log.challenge == res["challenge"] and log.model_version == res["model_version"] and log.timestamp is not None


def test_both_users_can_authenticate_as_themselves(client, trained):
    a, b = trained
    assert attempt(client, a, 0)["result"] == "AUTHENTICATED"
    assert attempt(client, b, 1)["result"] == "AUTHENTICATED"


def test_response_never_contains_biometric_data_or_other_users(client, trained):
    a, b = trained
    res = attempt(client, a, 0)
    text = json.dumps(res).lower()
    for word in ("centroid", "feature", "vector", "crop", "image", "base64", "ravi", str(b["id"]) + '"'):
        assert word not in text


# ------------------------------------------------------------ identity failures


def test_wrong_person_on_my_account_is_rejected_without_naming_them(client, trained, db):
    a, b = trained
    res = attempt(client, a, identity=1)  # Ravi's face, Asha's logged-in session, liveness performed correctly
    assert res["result"] == "REJECTED" and res["reason"] == "IDENTITY_MISMATCH"
    assert res["liveness"] == "PASSED" and res["identity"]["verified"] is False and res["identity"]["name"] is None
    assert "ravi" not in json.dumps(res).lower()
    log = db.get(AuthenticationLog, res["authentication_id"])
    assert log.user_id == a["id"] and log.result == "FAILED" and log.failure_reason == "IDENTITY_MISMATCH"


def test_unenrolled_stranger_is_rejected(client, trained_calibrated):
    """Needs the real distance threshold: with only 2 enrolled users a stranger is classified as one of
    them about half the time, so the distance gate is what stops them (see docs/face-authentication.md)."""
    a, _ = trained_calibrated
    res = attempt(client, a, identity=9)
    assert res["result"] == "REJECTED" and res["reason"] in ("IDENTITY_MISMATCH", "LOW_CONFIDENCE", "DISTANCE_TOO_HIGH")


def test_low_confidence_is_rejected(client, trained, monkeypatch):
    a, _ = trained
    monkeypatch.setattr(cfg, "AUTH_MIN_CONFIDENCE", 1.01)  # no classifier output can reach this
    res = attempt(client, a, 0)
    assert res["result"] == "REJECTED" and res["reason"] == "LOW_CONFIDENCE"
    assert res["identity"]["confidence"] < 1.01 and res["stages"][2]["status"] == "FAILED"


def test_excessive_distance_is_rejected(client, trained, db):
    """Tighten Asha's stored threshold to ~0 -> even her own face is 'too far' from her profile."""
    a, _ = trained
    set_threshold(db, [a["id"]], 1e-6)
    res = attempt(client, a, 0)
    assert res["result"] == "REJECTED" and res["reason"] == "DISTANCE_TOO_HIGH"
    assert res["identity"]["distance"] > res["identity"]["distance_threshold"]


def test_calibrated_threshold_on_synthetic_data_accepts_some_genuine_and_no_strangers(client, trained_calibrated):
    """Sanity check of the real, untouched threshold (not a performance claim: synthetic identities, 2 users).
    By construction of the percentile rule a sizeable share of genuine attempts is rejected."""
    a, _ = trained_calibrated
    genuine = [attempt(client, a, 0, start_var=300 + 5 * k)["result"] for k in range(10)]
    strangers = [attempt(client, a, 9, start_var=300 + 5 * k)["result"] for k in range(10)]
    print("calibrated synthetic: genuine accepted", genuine.count("AUTHENTICATED"), "/10; strangers", strangers.count("AUTHENTICATED"), "/10")
    assert 1 <= genuine.count("AUTHENTICATED") and strangers.count("AUTHENTICATED") == 0


# ------------------------------------------------------------ liveness failures


@pytest.mark.parametrize(
    "moves,detail",
    [([0.0, 0.0, 0.0, 0.0, 0.0], "NO_MOVEMENT"), ([0.01, 0.03, 0.05, 0.06, 0.06], "INCOMPLETE_MOVEMENT"),
     ([-0.05, -0.12, -0.18, -0.18, -0.18], "WRONG_DIRECTION")],
)
def test_failed_liveness_challenge_is_rejected_even_for_the_right_face(client, trained, db, moves, detail):
    a, _ = trained
    res = attempt(client, a, 0, moves=moves)
    assert res["result"] == "REJECTED" and res["reason"] == "LIVENESS_FAILED" and res["detail"] == detail
    assert res["liveness"] == "FAILED" and res["identity"] is None  # identity result is not disclosed
    assert [s["status"] for s in res["stages"]] == ["PASSED", "FAILED", "SKIPPED"]
    log = db.get(AuthenticationLog, res["authentication_id"])
    assert log.liveness_result == "FAILED" and log.failure_detail == detail
    assert log.confidence is not None  # the identity numbers are still logged for audit


# ------------------------------------------------------------ face detection failures


def test_multiple_faces_in_baseline_are_rejected(client, trained, db):
    a, _ = trained
    ch = get_challenge(client, a)
    frames = sequence(0, ch["challenge"], GOOD_TURN)
    frames[0] = scene(0, 300, extra=[(1, 5, 20, 70, 80)])
    res = verify(client, a, ch["challenge_id"], frames).json()
    assert res["result"] == "REJECTED" and res["reason"] == "MULTIPLE_FACES_DETECTED"
    assert res["liveness"] == "NOT_EVALUATED" and [s["status"] for s in res["stages"]] == ["FAILED", "SKIPPED", "SKIPPED"]


def test_second_face_appearing_during_the_challenge_is_rejected(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    frames = sequence(0, ch["challenge"], GOOD_TURN)
    frames[5] = scene(0, 301, extra=[(1, 5, 20, 70, 80)])
    res = verify(client, a, ch["challenge_id"], frames).json()
    assert res["reason"] == "MULTIPLE_FACES_DETECTED"


def test_small_background_face_is_still_blocked_but_a_speck_is_not(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    frames = sequence(0, ch["challenge"], GOOD_TURN)
    frames[1] = scene(0, 302, extra=[(1, 5, 10, 10, 40)])  # 40x40 = 17% of the main face area: blocks
    assert verify(client, a, ch["challenge_id"], frames).json()["reason"] == "MULTIPLE_FACES_DETECTED"
    ch = get_challenge(client, a)
    frames = sequence(0, ch["challenge"], GOOD_TURN)
    frames[1] = scene(0, 302, extra=[(1, 5, 10, 10, 20)])  # 20x20 = 4%: ignored
    assert verify(client, a, ch["challenge_id"], frames).json()["result"] == "AUTHENTICATED"


def test_no_face_is_rejected(client, trained, db):
    a, _ = trained
    ch = get_challenge(client, a)
    res = verify(client, a, ch["challenge_id"], [empty_scene()] * 6).json()
    assert res["result"] == "REJECTED" and res["reason"] == "FACE_NOT_DETECTED"
    assert db.get(AuthenticationLog, res["authentication_id"]).failure_reason == "FACE_NOT_DETECTED"


def test_blurry_baseline_is_poor_image_quality(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    frames = sequence(0, ch["challenge"], GOOD_TURN)
    frames[0] = blurry_scene(0, 1)
    res = verify(client, a, ch["challenge_id"], frames).json()
    assert res["reason"] == "POOR_IMAGE_QUALITY" and res["detail"] == "TOO_BLURRY"


def test_undecodable_frames_are_rejected_as_invalid_image(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    res = verify(client, a, ch["challenge_id"], [b"definitely not an image" * 5] * 6).json()
    assert res["result"] == "REJECTED" and res["reason"] == "INVALID_IMAGE"


# ------------------------------------------------------------ challenge lifecycle


def test_challenge_is_single_use(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    frames = sequence(0, ch["challenge"], GOOD_TURN)
    assert verify(client, a, ch["challenge_id"], frames).json()["result"] == "AUTHENTICATED"
    replay = verify(client, a, ch["challenge_id"], frames).json()
    assert replay["result"] == "REJECTED" and replay["reason"] == "CHALLENGE_INVALID"


def test_failed_attempt_also_spends_the_challenge(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    verify(client, a, ch["challenge_id"], sequence(0, ch["challenge"], [0.0] * 5))
    again = verify(client, a, ch["challenge_id"], sequence(0, ch["challenge"], GOOD_TURN)).json()
    assert again["reason"] == "CHALLENGE_INVALID"


def test_expired_challenge_times_out(client, trained, db):
    a, _ = trained
    ch = get_challenge(client, a)
    row = db.scalar(select(FaceAuthChallenge).where(FaceAuthChallenge.token == ch["challenge_id"]))
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    res = verify(client, a, ch["challenge_id"], sequence(0, ch["challenge"], GOOD_TURN)).json()
    assert res["result"] == "REJECTED" and res["reason"] == "CHALLENGE_EXPIRED"
    assert db.get(AuthenticationLog, res["authentication_id"]).failure_reason == "CHALLENGE_EXPIRED"


def test_unknown_and_foreign_challenges_are_invalid(client, trained):
    a, b = trained
    frames = sequence(0, "turn_left", GOOD_TURN)
    assert verify(client, a, "x" * 40, frames).json()["reason"] == "CHALLENGE_INVALID"
    theirs = get_challenge(client, b)
    res = verify(client, a, theirs["challenge_id"], sequence(0, theirs["challenge"], GOOD_TURN)).json()
    assert res["reason"] == "CHALLENGE_INVALID"
    # and it was not consumed by that attempt: its owner can still use it
    assert verify(client, b, theirs["challenge_id"], sequence(1, theirs["challenge"], GOOD_TURN)).json()["result"] == "AUTHENTICATED"


# ------------------------------------------------------------ account / model state


def test_disabled_account_is_rejected_and_logged(client, trained, db):
    a, _ = trained
    ch = get_challenge(client, a)
    db.get(User, a["id"]).status = "disabled"
    db.commit()
    res = verify(client, a, ch["challenge_id"], sequence(0, ch["challenge"], GOOD_TURN)).json()
    assert res["result"] == "REJECTED" and res["reason"] == "ACCOUNT_DISABLED"
    assert [s["status"] for s in res["stages"]] == ["SKIPPED"] * 3
    assert db.get(AuthenticationLog, res["authentication_id"]).failure_reason == "ACCOUNT_DISABLED"
    assert client.post("/face-auth/challenge", headers=a["headers"]).status_code == 403  # cannot start a new one


def test_missing_model_is_model_unavailable(client, db):
    a = new_customer(client)
    ch = get_challenge(client, a)
    res = verify(client, a, ch["challenge_id"], sequence(0, ch["challenge"], GOOD_TURN)).json()
    assert res["result"] == "REJECTED" and res["reason"] == "MODEL_UNAVAILABLE" and res["model_version"] is None
    assert db.scalar(select(AuthenticationLog.failure_reason)) == "MODEL_UNAVAILABLE"


def test_corrupted_model_is_model_unavailable(client, trained, db):
    a, _ = trained
    from app.ml import registry

    row = db.scalar(select(ModelVersion))
    blob = bytearray(row.artifact)
    blob[40] ^= 1
    row.artifact = bytes(blob)
    db.commit()
    registry.invalidate()
    assert attempt(client, a, 0)["reason"] == "MODEL_UNAVAILABLE"


def test_user_not_in_the_model_is_not_enrolled(client, trained):
    c = new_customer(client)
    res = attempt(client, c, 2)
    assert res["result"] == "REJECTED" and res["reason"] == "NOT_ENROLLED"


# ------------------------------------------------------------ malformed requests


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"challenge_id": "short", "frames": ["A" * 40] * 6},
        {"challenge_id": "c" * 40},
        {"challenge_id": "c" * 40, "frames": ["A" * 40] * (cfg.AUTH_MIN_FRAMES - 1)},
        {"challenge_id": "c" * 40, "frames": ["A" * 40] * (cfg.AUTH_MAX_FRAMES + 1)},
        {"challenge_id": "c" * 40, "frames": ["!!not base64!!" * 5] * 6},
        {"challenge_id": "c" * 40, "frames": [123] * 6},
        {"challenge_id": "c" * 40, "frames": ["A" * 1_000_001] * 6},
    ],
)
def test_malformed_requests_are_422_and_not_logged(client, trained, db, body):
    a, _ = trained
    r = client.post("/face-auth/verify", json=body, headers=a["headers"])
    assert r.status_code == 422
    assert "A" * 40 not in r.text  # validation errors do not echo the submitted data
    assert db.scalar(select(AuthenticationLog)) is None


def test_malformed_request_does_not_spend_the_challenge(client, trained):
    a, _ = trained
    ch = get_challenge(client, a)
    assert client.post("/face-auth/verify", json={"challenge_id": ch["challenge_id"], "frames": ["!!"] * 6}, headers=a["headers"]).status_code == 422
    assert verify(client, a, ch["challenge_id"], sequence(0, ch["challenge"], GOOD_TURN)).json()["result"] == "AUTHENTICATED"


# ------------------------------------------------------------ logs + limits


def test_every_attempt_is_logged_and_users_see_only_their_own(client, trained, db):
    a, b = trained
    attempt(client, a, 0)
    attempt(client, a, 1)  # wrong face
    attempt(client, a, 0, moves=[0] * 5)  # liveness failure
    attempt(client, b, 1)
    rows = db.scalars(select(AuthenticationLog).order_by(AuthenticationLog.id)).all()
    assert [(r.user_id == a["id"], r.result) for r in rows] == [(True, "SUCCESS"), (True, "FAILED"), (True, "FAILED"), (False, "SUCCESS")]
    mine = client.get("/face-auth/attempts", headers=a["headers"]).json()
    assert [m["result"] for m in mine] == ["FAILED", "FAILED", "SUCCESS"]  # newest first, only Asha's
    assert mine[0]["failure_reason"] == "LIVENESS_FAILED" and mine[1]["failure_reason"] == "IDENTITY_MISMATCH"
    assert set(mine[0]) == {"id", "timestamp", "result", "failure_reason", "failure_detail", "confidence", "distance",
                            "liveness_result", "challenge", "model_version"}
    assert client.get("/face-auth/attempts?limit=1", headers=a["headers"]).json()[0]["id"] == mine[0]["id"]
    assert client.get("/face-auth/attempts?limit=0", headers=a["headers"]).status_code == 422


def test_log_rows_hold_no_raw_biometric_data(db, client, trained):
    a, _ = trained
    attempt(client, a, 0)
    row = db.scalar(select(AuthenticationLog))
    for col in AuthenticationLog.__table__.columns:
        assert not isinstance(getattr(row, col.name), (bytes, bytearray, memoryview))


def test_phase3_recognition_still_works_next_to_authentication(client, trained):
    a, _ = trained
    r = client.post("/faces/recognize", json={"image_base64": b64(scene(0, 77))}, headers=a["headers"])
    assert r.status_code == 200 and r.json()["predicted_is_you"] is True


def test_attempt_rate_limit(client, trained, monkeypatch):
    from app.api import face_auth as fa

    a, _ = trained
    monkeypatch.setattr(fa.face_auth_limiter, "enabled", True)
    monkeypatch.setattr(fa.face_auth_limiter, "max_requests", 3)
    fa.face_auth_limiter.reset()
    codes = [client.post("/face-auth/challenge", headers=a["headers"]).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    fa.face_auth_limiter.reset()
