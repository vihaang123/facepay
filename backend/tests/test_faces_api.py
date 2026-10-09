import base64
import json

import numpy as np
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.api import faces as faces_api
from app.core import crypto
from app.main import app
from app.ml import config as cfg
from app.ml.preprocessing import FullFrameDetector
from app.models import FaceProfile, FaceSample, ModelVersion
from tests.conftest import STRONG_PASSWORD, unique_email
from tests.synthetic_faces import png_bytes, sample_image

POSES = list(cfg.POSES)


@pytest.fixture(autouse=True)
def fake_detector():
    """Synthetic images are not faces: treat the whole frame as the face."""
    app.dependency_overrides[faces_api.get_detector] = lambda: FullFrameDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


def b64(img) -> str:
    return base64.b64encode(png_bytes(img)).decode()


def new_customer(client):
    email = unique_email("c")
    r = client.post("/auth/register", json={"name": "N", "email": email, "password": STRONG_PASSWORD})
    assert r.status_code == 201
    tok = client.post("/auth/login", json={"email": email, "password": STRONG_PASSWORD}).json()["access_token"]
    return {"id": r.json()["id"], "headers": {"Authorization": f"Bearer {tok}"}}


def enroll(client, cust, identity, n=12):
    for i in range(n):
        r = client.post(
            "/faces/samples",
            json={"image_base64": b64(sample_image(identity, i)), "pose": POSES[i % 4]},
            headers=cust["headers"],
        )
        assert r.status_code == 201, r.text


@pytest.fixture
def two_users(client):
    a, b = new_customer(client), new_customer(client)
    enroll(client, a, 0)
    enroll(client, b, 1)
    return a, b


@pytest.fixture
def trained(client, two_users):
    a, b = two_users
    r = client.post("/faces/train", headers=a["headers"])
    assert r.status_code == 200, r.text
    return a, b, r.json()


# ------------------------------------------------------------ access control


@pytest.mark.parametrize(
    "method,path",
    [("get", "/faces/enrollment"), ("post", "/faces/samples"), ("delete", "/faces/samples"),
     ("post", "/faces/train"), ("get", "/faces/model"), ("post", "/faces/recognize")],
)
def test_face_routes_require_authentication(client, method, path):
    assert getattr(client, method)(path).status_code == 401


def test_merchant_token_cannot_use_face_routes(client, merchant):
    assert client.get("/faces/enrollment", headers=merchant["headers"]).status_code == 403


# ------------------------------------------------------------ enrollment


def test_enrollment_status_starts_empty(client, customer):
    r = client.get("/faces/enrollment", headers=customer["headers"])
    body = r.json()
    assert r.status_code == 200
    assert body["total_samples"] == 0 and body["eligible"] is False and body["has_profile"] is False
    assert {p["pose"] for p in body["poses"]} == set(cfg.POSES)


def test_sample_accepted_and_response_has_no_biometric_data(client, customer):
    r = client.post("/faces/samples", json={"image_base64": b64(sample_image(0, 0)), "pose": "neutral"},
                    headers=customer["headers"])
    assert r.status_code == 201
    body = r.json()
    assert body["accepted"] and body["enrollment"]["total_samples"] == 1
    assert set(body["quality"]) == {"sharpness", "brightness", "face_size", "aligned"}
    dumped = json.dumps(body).lower()
    assert not any(w in dumped for w in ("image", "crop", "centroid", "vector", "feature"))


def test_data_url_prefix_is_accepted(client, customer):
    r = client.post("/faces/samples",
                    json={"image_base64": "data:image/png;base64," + b64(sample_image(0, 1)), "pose": "smile"},
                    headers=customer["headers"])
    assert r.status_code == 201


@pytest.mark.parametrize(
    "payload,code",
    [
        ({"image_base64": "!!!not base64!!!!!!!!", "pose": "neutral"}, "INVALID_IMAGE"),
        ({"image_base64": base64.b64encode(b"x" * 100).decode(), "pose": "neutral"}, "INVALID_IMAGE"),
    ],
)
def test_bad_images_give_reason_codes(client, customer, payload, code):
    r = client.post("/faces/samples", json=payload, headers=customer["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == code


def test_blurry_dark_and_unknown_pose_are_rejected(client, customer):
    import cv2

    blurry = cv2.GaussianBlur(sample_image(0, 0), (0, 0), 6)
    dark = (sample_image(0, 0) * 0.15).astype(np.uint8)
    for img, code in ((blurry, "TOO_BLURRY"), (dark, "TOO_DARK")):
        r = client.post("/faces/samples", json={"image_base64": b64(img), "pose": "neutral"}, headers=customer["headers"])
        assert r.status_code == 422 and r.json()["detail"]["code"] == code
    r = client.post("/faces/samples", json={"image_base64": b64(sample_image(0, 0)), "pose": "dance"},
                    headers=customer["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "UNKNOWN_POSE"
    assert client.get("/faces/enrollment", headers=customer["headers"]).json()["total_samples"] == 0


def test_oversized_payload_is_rejected(client, customer):
    r = client.post("/faces/samples", json={"image_base64": "A" * 2_200_000, "pose": "neutral"},
                    headers=customer["headers"])
    assert r.status_code == 422


def test_per_pose_and_total_limits(client, customer, monkeypatch):
    monkeypatch.setattr(cfg, "MAX_SAMPLES_PER_POSE", 2)
    for i in range(2):
        assert client.post("/faces/samples", json={"image_base64": b64(sample_image(0, i)), "pose": "neutral"},
                           headers=customer["headers"]).status_code == 201
    r = client.post("/faces/samples", json={"image_base64": b64(sample_image(0, 9)), "pose": "neutral"},
                    headers=customer["headers"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "POSE_LIMIT"
    monkeypatch.setattr(cfg, "MAX_SAMPLES_PER_USER", 2)
    r = client.post("/faces/samples", json={"image_base64": b64(sample_image(0, 9)), "pose": "smile"},
                    headers=customer["headers"])
    assert r.json()["detail"]["code"] == "SAMPLE_LIMIT"


def test_samples_are_isolated_per_user(client, two_users):
    a, b = two_users
    assert client.get("/faces/enrollment", headers=a["headers"]).json()["total_samples"] == 12
    c = new_customer(client)
    assert client.get("/faces/enrollment", headers=c["headers"]).json()["total_samples"] == 0


def test_stored_crops_are_encrypted_bound_to_their_row_and_not_raw_frames(client, customer, db):
    img = sample_image(0, 0)
    client.post("/faces/samples", json={"image_base64": b64(img), "pose": "neutral"}, headers=customer["headers"])
    row = db.scalar(select(FaceSample))
    blob = row.crop_encrypted
    assert len(blob) == 1 + 12 + cfg.IMAGE_SIZE**2 + 16  # version + nonce + 64x64 crop + tag: no frame, no PNG header
    assert b"\x89PNG" not in blob
    crop = crypto.decrypt(blob, f"face_sample:{row.user_id}:{row.id}")
    assert len(crop) == cfg.IMAGE_SIZE**2
    with pytest.raises(crypto.BiometricCryptoError):
        crypto.decrypt(blob, f"face_sample:{row.user_id}:{row.id + 1}")


# ------------------------------------------------------------ training


def test_train_requires_enough_samples(client, customer):
    r = client.post("/faces/train", headers=customer["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NOT_ENOUGH_SAMPLES"


def test_train_requires_poses_variety(client, customer):
    for i in range(12):
        client.post("/faces/samples", json={"image_base64": b64(sample_image(0, i)), "pose": "neutral"},
                    headers=customer["headers"])
    r = client.post("/faces/train", headers=customer["headers"])
    assert r.json()["detail"]["code"] == "NOT_ENOUGH_SAMPLES"


def test_train_requires_two_users(client, customer):
    enroll(client, customer, 0)
    r = client.post("/faces/train", headers=customer["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NOT_ENOUGH_USERS"


def test_train_reports_real_cross_validated_comparison(client, trained, db):
    a, b, m = trained
    # Customers learn whether the model is ready and includes them. Classifier internals are administrator-only.
    assert set(m) == {"version", "trained_at", "includes_you", "stale"} and m["includes_you"] and not m["stale"]
    for hidden in ("comparison", "pca", "lda", "classifier", "validation", "n_users", "n_samples", "distance_threshold"):
        assert hidden not in m
    # metrics are stored from the same run (not hand written), and no user ids leak in the API
    row = db.scalar(select(ModelVersion))
    assert row.n_classes == 2 and row.n_samples == 24 and row.classifier in ("pca_lda_knn", "pca_lda_svm")
    assert row.evaluation_metrics["validation"].startswith("group_kfold_by_pose")
    assert set(row.evaluation_metrics["variants"]) == {"pca_knn", "pca_lda_knn", "pca_lda_svm"}
    assert row.lda_config["n_components"] == 1  # C - 1
    assert row.pca_config["n_components"] <= row.pca_config["cap_n_minus_c"]
    assert "confusion_matrix" not in json.dumps(m) and "labels" not in json.dumps(m)
    assert "scatter" in row.evaluation_metrics


def test_artifact_and_profiles_are_encrypted(client, trained, db):
    a, b, m = trained
    row = db.scalar(select(ModelVersion))
    assert row.status == "active" and row.n_classes == 2 and len(row.dataset_fingerprint) == 64
    assert row.artifact[:1] == b"\x01" and b"sklearn" not in row.artifact
    prof = db.scalar(select(FaceProfile).where(FaceProfile.user_id == a["id"]))
    assert prof.status == "active" and prof.model_version_id == row.id and prof.sample_count == 12
    data = json.loads(crypto.decrypt(prof.feature_data, f"face_profile:{a['id']}:{row.version}"))
    assert len(data["centroid"]) == 1 and data["distance_threshold"] > 0


def test_retraining_retires_the_previous_model_and_keeps_single_active(client, trained, db):
    a, b, first = trained
    second = client.post("/faces/train", headers=a["headers"]).json()
    assert second["version"] != first["version"]
    statuses = [r.status for r in db.scalars(select(ModelVersion).order_by(ModelVersion.id))]
    assert statuses == ["retired", "active"]
    active_profiles = db.scalars(select(FaceProfile).where(FaceProfile.status == "active")).all()
    assert len(active_profiles) == 2 and {p.model_version_id for p in active_profiles} == {2}


def test_database_allows_only_one_active_model_and_profile(trained, db):
    db.add(ModelVersion(version="dup", status="active"))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    a, _, _ = trained
    db.add(FaceProfile(user_id=a["id"], status="active"))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_model_status_endpoint(client, two_users):
    a, _ = two_users
    assert client.get("/faces/model", headers=a["headers"]).json() == {"model": None}
    client.post("/faces/train", headers=a["headers"])
    m = client.get("/faces/model", headers=a["headers"]).json()["model"]
    assert m["includes_you"] and m["stale"] is False
    client.post("/faces/samples", json={"image_base64": b64(sample_image(0, 50)), "pose": "neutral"}, headers=a["headers"])
    assert client.get("/faces/model", headers=a["headers"]).json()["model"]["stale"] is True


def test_concurrent_training_is_refused(client, two_users):
    from app.services import face_service

    a, _ = two_users
    assert face_service._train_lock.acquire(blocking=False)
    try:
        r = client.post("/faces/train", headers=a["headers"])
        assert r.status_code == 409 and r.json()["detail"]["code"] == "TRAINING_BUSY"
    finally:
        face_service._train_lock.release()


# ------------------------------------------------------------ recognition


def test_recognition_before_training_is_a_clear_error(client, two_users):
    a, _ = two_users
    r = client.post("/faces/recognize", json={"image_base64": b64(sample_image(0, 100))}, headers=a["headers"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "MODEL_NOT_TRAINED"


def test_recognizes_the_registered_customer_with_a_new_sample(client, trained):
    a, b, _ = trained
    for who, ident in ((a, 0), (b, 1)):
        r = client.post("/faces/recognize", json={"image_base64": b64(sample_image(ident, 100))}, headers=who["headers"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["matched"] and body["reason"] == "MATCH" and body["predicted_is_you"]
        assert set(body) == {"matched", "reason", "predicted_is_you", "model_version", "quality"}  # no scores or ids


def test_someone_elses_face_is_not_accepted_and_their_identity_is_not_revealed(client, trained):
    a, b, _ = trained
    r = client.post("/faces/recognize", json={"image_base64": b64(sample_image(1, 101))}, headers=a["headers"])
    body = r.json()
    assert r.status_code == 200 and body["matched"] is False
    assert body["reason"] == "WRONG_IDENTITY" and body["predicted_is_you"] is False
    assert "user_id" not in body and "confidence" not in body and "distance_to_you" not in body


def test_unknown_face_far_from_profile_is_rejected(client, trained):
    a, _, _ = trained
    stranger = sample_image(7, 3)
    body = client.post("/faces/recognize", json={"image_base64": b64(stranger)}, headers=a["headers"]).json()
    assert body["matched"] is False  # either classified as the other user or too far from your profile


def test_recognize_bad_image_gives_reason_code(client, trained):
    a, _, _ = trained
    r = client.post("/faces/recognize", json={"image_base64": base64.b64encode(b"junk" * 10).decode()}, headers=a["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "INVALID_IMAGE"


def test_user_enrolled_after_training_is_not_in_model(client, trained):
    c = new_customer(client)
    enroll(client, c, 2)
    r = client.post("/faces/recognize", json={"image_base64": b64(sample_image(2, 100))}, headers=c["headers"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "NOT_IN_MODEL"


def test_deleting_face_data_removes_samples_profile_and_retires_model(client, trained, db):
    a, b, _ = trained
    assert client.delete("/faces/samples", headers=a["headers"]).status_code == 204
    assert db.scalar(text("select count(*) from face_samples where user_id = :u"), {"u": a["id"]}) == 0
    assert db.scalars(select(ModelVersion.status)).all() == ["retired"]
    assert db.scalars(select(FaceProfile).where(FaceProfile.status == "active")).all() == []
    assert db.scalar(select(FaceProfile.feature_data).where(FaceProfile.user_id == a["id"])) is None
    r = client.post("/faces/recognize", json={"image_base64": b64(sample_image(1, 100))}, headers=b["headers"])
    assert r.json()["detail"]["code"] == "MODEL_NOT_TRAINED"
    assert client.get("/faces/enrollment", headers=b["headers"]).json()["total_samples"] == 12  # others untouched


def test_corrupted_model_artifact_fails_safely(client, trained, db):
    a, _, _ = trained
    from app.ml import registry

    row = db.scalar(select(ModelVersion))
    blob = bytearray(row.artifact)
    blob[30] ^= 1
    row.artifact = bytes(blob)
    db.commit()
    registry.invalidate()
    r = client.post("/faces/recognize", json={"image_base64": b64(sample_image(0, 100))}, headers=a["headers"])
    assert r.status_code == 503 and r.json()["detail"]["code"] == "MODEL_UNAVAILABLE"


def test_real_haar_detector_is_wired_into_the_api(client, customer):
    app.dependency_overrides.pop(faces_api.get_detector)
    with open("tests/fixtures/astronaut.jpg", "rb") as f:
        photo = base64.b64encode(f.read()).decode()
    r = client.post("/faces/samples", json={"image_base64": photo, "pose": "neutral"}, headers=customer["headers"])
    assert r.status_code == 201, r.text
    assert r.json()["quality"]["face_size"] >= cfg.MIN_FACE_PIXELS
    # a frame with no face in it is refused by the real detector
    blank = base64.b64encode(png_bytes(np.full((240, 320), 128, np.uint8))).decode()
    r = client.post("/faces/samples", json={"image_base64": blank, "pose": "smile"}, headers=customer["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NO_FACE"


def test_face_rate_limit(client, customer, monkeypatch):
    monkeypatch.setattr(faces_api.face_limiter, "enabled", True)
    monkeypatch.setattr(faces_api.face_limiter, "max_requests", 2)
    faces_api.face_limiter.reset()
    codes = [client.post("/faces/recognize", json={"image_base64": "A" * 20}, headers=customer["headers"]).status_code
             for _ in range(3)]
    assert codes[-1] == 429
    faces_api.face_limiter.reset()
