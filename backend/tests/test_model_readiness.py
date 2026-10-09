"""Why a face check can or cannot run, and that a technical problem is never reported as a face mismatch.

The production symptom this file reproduces: a customer enrolled 15 good samples, the camera worked, and every check said
"Recognition is unavailable". The cause is that the shared PCA -> LDA model needs at least two enrolled people; with one
person no model can exist, and the backend used to report that (and any model-loading error) with one catch-all code.
Real PostgreSQL, synthetic face frames."""

import json
import logging

import numpy as np
import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import OperationalError

from app.ml import config as cfg
from app.ml import registry
from app.ml.pipeline import FacePipeline
from app.models import AuthenticationLog, FaceProfile, ModelVersion, User
from app.services import face_service
from tests.payment_helpers import b64, create_session, enroll, new_customer, new_merchant, set_threshold
from tests.synthetic_scenes import GOOD_TURN, scene, sequence

pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes

GUIDED = list(cfg.GUIDED_SEQUENCE)  # the five poses the app walks a customer through, three samples each = 15 samples


def enroll_guided(client, cust, identity):
    """What the guided setup produces: 15 accepted samples across 5 poses."""
    for i in range(15):
        r = client.post("/faces/samples", json={"image_base64": b64(scene(identity, i, x=120 + (i * 13) % 80)), "pose": GUIDED[i // 3]},
                        headers=cust["headers"])
        assert r.status_code == 201, r.text


def readiness(client, cust):
    r = client.get("/faces/readiness", headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def challenge(client, cust):
    return client.post("/face-auth/challenge", headers=cust["headers"])


def verify(client, cust, ch, identity, moves=GOOD_TURN):
    frames = [b64(f) for f in sequence(identity, ch["challenge"], moves)]
    r = client.post("/face-auth/verify", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def lone(client):
    """One customer with a complete guided setup (15 samples, 5 poses) and nobody else."""
    a = new_customer(client, "Asha Rao")
    enroll_guided(client, a, 0)
    return a


@pytest.fixture
def two(client, db):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll_guided(client, a, 0)
    enroll_guided(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    set_threshold(db, [a["id"], b["id"]], 1000.0)
    return a, b


# ------------------------------------------------------------ the reported production situation


def test_fifteen_good_samples_from_one_person_cannot_produce_a_model_and_the_reason_says_so(client, lone, db):
    f = face_service.enrollment_status(db, db.get(User, lone["id"]))
    assert f["total_samples"] == 15 and f["distinct_poses"] == 5 and f["eligible"] is True  # the UI count is the usable count
    state = readiness(client, lone)
    assert state["ready"] is False and state["code"] == "INSUFFICIENT_IDENTITIES" and state["next_action"] == "WAIT_FOR_SECOND_PERSON"
    assert state["checks"]["samples"] == {"have": 15, "need": cfg.MIN_SAMPLES_PER_USER}
    assert state["checks"]["people_with_finished_setup"] == {"enough": False}
    r = client.post("/faces/train", headers=lone["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NOT_ENOUGH_USERS"
    assert db.scalars(select(ModelVersion)).all() == []  # no model was invented


def test_with_no_model_nothing_asks_the_camera_for_frames(client, lone, db):
    r = challenge(client, lone)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "INSUFFICIENT_IDENTITIES"
    shop = new_merchant(client)
    sid = create_session(client, shop)["session_id"]
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=lone["headers"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "INSUFFICIENT_IDENTITIES"
    assert db.scalars(select(AuthenticationLog)).all() == []  # nothing was judged, so nothing is on the failure record


def test_a_second_enrolled_person_makes_the_same_fifteen_samples_sufficient(client, lone, db):
    other = new_customer(client, "Ravi Shah")
    enroll_guided(client, other, 1)
    assert readiness(client, lone)["code"] == "MODEL_NOT_TRAINED" and readiness(client, lone)["next_action"] == "TRAIN"
    assert client.post("/faces/train", headers=lone["headers"]).status_code == 200
    state = readiness(client, lone)
    assert state["ready"] is True and state["code"] is None and state["checks"]["you_are_in_model"] is True
    assert state["model_version"]


def test_fifteen_samples_in_a_single_pose_do_not_count_as_enrolled(client, db):
    a = new_customer(client, "Asha Rao")
    for i in range(15):
        r = client.post("/faces/samples", json={"image_base64": b64(scene(0, i, x=120 + (i * 13) % 80)), "pose": "neutral"}, headers=a["headers"])
        assert r.status_code == 201, r.text
    state = readiness(client, a)
    assert state["code"] == "ENROLLMENT_INSUFFICIENT" and state["next_action"] == "ENROLL"
    assert state["checks"]["samples"]["have"] == 15 and state["checks"]["poses"] == {"have": 1, "need": cfg.MIN_POSES_PER_USER}
    b = new_customer(client, "Ravi Shah")
    enroll_guided(client, b, 1)
    r = client.post("/faces/train", headers=a["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NOT_ENOUGH_SAMPLES"


def test_too_few_samples_are_not_enough_even_with_enough_poses(client):
    a = new_customer(client, "Asha Rao")
    enroll(client, a, 0, n=cfg.MIN_SAMPLES_PER_USER - 1)
    assert readiness(client, a)["code"] == "ENROLLMENT_INSUFFICIENT"


def test_the_configured_requirement_is_twelve_samples_in_three_poses_and_two_people():
    assert (cfg.MIN_SAMPLES_PER_USER, cfg.MIN_POSES_PER_USER, cfg.MIN_USERS_TO_TRAIN) == (12, 3, 2)


# ------------------------------------------------------------ a model exists


def test_a_valid_trained_model_loads_and_a_genuine_user_is_accepted(client, two):
    a, _ = two
    assert readiness(client, a)["ready"] is True
    r = challenge(client, a)
    assert r.status_code == 200
    res = verify(client, a, r.json(), identity=0)
    assert res["result"] == "AUTHENTICATED" and res["reason"] is None
    stages = {s["stage"]: s["status"] for s in res["stages"]}
    assert stages == {"MODEL": "PASSED", "FACE_DETECTION": "PASSED", "LIVENESS": "PASSED", "IDENTITY": "PASSED"}


def test_a_wrong_identity_is_a_real_rejection_with_the_model_stage_passed(client, two):
    a, _ = two
    res = verify(client, a, challenge(client, a).json(), identity=1)  # Ravi's face on Asha's account
    assert res["result"] == "REJECTED" and res["reason"] in ("IDENTITY_MISMATCH", "LOW_CONFIDENCE", "DISTANCE_TOO_HIGH")
    stages = {s["stage"]: s["status"] for s in res["stages"]}
    assert stages["MODEL"] == "PASSED" and stages["IDENTITY"] == "FAILED"


def test_a_liveness_failure_is_rejected_for_the_right_face(client, two):
    a, _ = two
    res = verify(client, a, challenge(client, a).json(), identity=0, moves=[0.0] * 5)
    assert res["result"] == "REJECTED" and res["reason"] == "LIVENESS_FAILED"


def test_samples_added_after_training_make_the_model_stale_for_that_person_but_not_for_the_trained_ones(client, two):
    a, _ = two
    c = new_customer(client, "Chitra Iyer")
    enroll_guided(client, c, 2)
    mine = readiness(client, a)
    assert mine["ready"] is True and mine["stale"] is True  # still valid for Asha; newer samples exist elsewhere
    theirs = readiness(client, c)
    assert theirs["ready"] is False and theirs["code"] == "MODEL_STALE" and theirs["next_action"] == "TRAIN"
    r = challenge(client, c)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "MODEL_STALE"
    assert client.post("/faces/train", headers=c["headers"]).status_code == 200
    assert readiness(client, c)["ready"] is True and readiness(client, a)["ready"] is True


def test_deleting_face_data_retires_the_shared_model_and_says_so_to_the_other_person(client, two):
    a, b = two
    assert client.delete("/faces/samples", headers=a["headers"]).status_code == 204
    state = readiness(client, b)
    assert state["ready"] is False and state["code"] == "INSUFFICIENT_IDENTITIES"  # Ravi alone cannot make a model


# ------------------------------------------------------------ technical failures are never "mismatch"


def test_a_tampered_model_is_a_decryption_failure_not_a_mismatch(client, two, db):
    a, _ = two
    row = db.scalar(select(ModelVersion))
    blob = bytearray(row.artifact)
    blob[40] ^= 1
    row.artifact = bytes(blob)
    db.commit()
    registry.invalidate()
    state = readiness(client, a)
    assert state["code"] == "BIOMETRIC_DECRYPTION_FAILED" and state["ready"] is False
    r = challenge(client, a)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "BIOMETRIC_DECRYPTION_FAILED"
    assert "gcm" not in r.text.lower() and "traceback" not in r.text.lower() and "key" not in r.json()["detail"]["message"].lower()


def test_a_model_trained_with_other_library_versions_is_reported_as_incompatible(client, two, db):
    a, _ = two
    db.execute(update(ModelVersion).values(library_versions={"scikit-learn": "0.1.0", "numpy": "0.1.0", "joblib": "0.1.0"}))
    db.commit()
    registry.invalidate()
    state = readiness(client, a)
    assert state["code"] == "MODEL_VERSION_INCOMPATIBLE" and state["next_action"] == "TRAIN"
    # retraining with the stored samples fixes it, using the normal authenticated workflow
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    assert readiness(client, a)["ready"] is True


def test_an_unreadable_face_profile_is_a_decryption_failure(client, two, db):
    a, _ = two
    prof = db.scalar(select(FaceProfile).where(FaceProfile.user_id == a["id"], FaceProfile.status == "active"))
    bad = bytearray(prof.feature_data)
    bad[-3] ^= 1
    prof.feature_data = bytes(bad)
    db.commit()
    assert readiness(client, a)["code"] == "BIOMETRIC_DECRYPTION_FAILED"


def test_a_database_error_is_a_server_error_never_a_model_or_identity_problem(client, two, monkeypatch):
    a, _ = two

    def boom(db):
        raise OperationalError("select 1", {}, Exception("connection lost"))

    monkeypatch.setattr(registry, "active_model_row", boom)
    try:
        r = client.get("/faces/readiness", headers=a["headers"])
    except OperationalError:
        return  # propagated to the server error handler: not converted into a model status
    assert r.status_code >= 500 and "code" not in (r.json().get("detail") or {})


def test_an_unexpected_error_while_checking_is_logged_as_a_server_error_not_a_mismatch(client, two, db, monkeypatch):
    a, _ = two
    ch = challenge(client, a).json()
    monkeypatch.setattr("app.services.face_auth_service.liveness.observe", lambda *x, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    frames = [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN)]
    client2 = type(client)(client.app, raise_server_exceptions=False)
    r = client2.post("/face-auth/verify", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=a["headers"])
    assert r.status_code == 500
    assert db.scalar(select(AuthenticationLog.failure_reason).order_by(AuthenticationLog.id.desc())) == "INTERNAL_ERROR"


# ------------------------------------------------------------ training does not damage a working model


def test_a_training_run_that_fails_while_saving_leaves_the_previous_model_working(client, two, db, monkeypatch):
    a, _ = two
    before = db.scalar(select(ModelVersion.version).where(ModelVersion.status == "active"))

    def fail(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(face_service, "dump_model", fail)
    client2 = type(client)(client.app, raise_server_exceptions=False)
    r = client2.post("/faces/train", headers=a["headers"])
    assert r.status_code >= 500
    db.expire_all()
    assert db.scalars(select(ModelVersion.version).where(ModelVersion.status == "active")).all() == [before]
    assert db.scalar(select(FaceProfile).where(FaceProfile.user_id == a["id"], FaceProfile.status == "active")) is not None
    monkeypatch.undo()
    assert readiness(client, a)["ready"] is True


def test_a_fitting_error_is_reported_with_a_code_and_changes_nothing(client, two, db, monkeypatch):
    a, _ = two

    def fail(*args, **kwargs):
        raise np.linalg.LinAlgError("singular")

    monkeypatch.setattr(face_service, "compare_and_select", fail)
    r = client.post("/faces/train", headers=a["headers"])
    assert r.status_code == 500 and r.json()["detail"]["code"] == "TRAINING_FAILED"
    assert "singular" not in r.text and "LinAlg" not in r.text
    assert len(db.scalars(select(ModelVersion).where(ModelVersion.status == "active")).all()) == 1


# ------------------------------------------------------------ PCA / LDA dimensions


@pytest.mark.parametrize("people,per_person", [(2, 15), (3, 12), (2, 12)])
def test_component_counts_respect_the_mathematical_limits(people, per_person):
    rng = np.random.default_rng(0)
    X = np.vstack([rng.normal(loc=i * 3.0, scale=1.0, size=(per_person, 4096)) for i in range(people)])
    y = np.repeat(np.arange(people), per_person)
    model = FacePipeline(use_lda=True, classifier="knn").fit(X, y)
    n, c = len(y), people
    assert model.pca_.n_components_ <= n - c  # keeps the within-class scatter non-singular
    assert model.lda_.n_components <= c - 1  # LDA cannot have more discriminants than classes minus one
    assert model.transform(X[:2]).shape[1] == model.lda_.n_components


# ------------------------------------------------------------ what customers see and what is logged


def test_readiness_exposes_no_model_internals_and_names_nobody(client, two):
    a, _ = two
    body = json.dumps(readiness(client, a))
    for forbidden in ("centroid", "threshold", "distance", "pca", "lda", "eigen", "Ravi", "BIOMETRIC", "artifact"):
        assert forbidden.lower() not in body.lower()


def test_the_restricted_log_has_the_code_and_ids_but_no_secrets_or_biometrics(client, lone, caplog):
    with caplog.at_level(logging.INFO, logger="facepay.face"):
        readiness(client, lone)
    text_ = caplog.text
    assert "INSUFFICIENT_IDENTITIES" in text_ and f"user_id={lone['id']}" in text_
    for forbidden in ("BIOMETRIC_KEY", "password", "token", "base64", "centroid"):
        assert forbidden.lower() not in text_.lower()


def test_failed_attempts_for_a_missing_model_do_not_count_against_the_customer(client, two, db):
    a, _ = two
    db.execute(text("UPDATE model_versions SET status = 'retired'"))
    db.commit()
    registry.invalidate()
    for _ in range(12):  # far more than the lockout threshold
        assert challenge(client, a).status_code == 409
    assert client.get("/security/overview", headers=a["headers"]).json().get("biometric_locked", False) is False
