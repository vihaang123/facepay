"""The recognition recipe that replaced "every frame within the 70th percentile of one pooled distance".

Production symptom: the account owner passed face detection and liveness and was still rejected at identity recognition,
five times in a row. The recipe is: train on slightly perturbed copies of the stored samples, calibrate the threshold on
held-out samples (plus perturbed copies of them), one threshold per person, mean-distance decision, and rebuild an older
model from the stored samples automatically.

Offline accuracy numbers (ORL faces) are in ml/experiments/auth_policy_v4.py; these tests cover the mechanics, with real
PostgreSQL and synthetic faces (which are NOT faces)."""

import json

import numpy as np
import pytest
from sqlalchemy import func, select, update

from app.core import crypto
from app.ml import config as cfg
from app.ml import recipe, registry
from app.ml.augment import AugmentedSet, augment_crop, augmented_vectors
from app.ml.evaluation import _with_copies, compare_and_select, evaluate_variant, make_splits, user_thresholds
from app.ml.pipeline import FacePipeline
from app.ml.preprocessing import crop_to_stored, vectorize
from app.models import FaceProfile, FaceSample, ModelVersion
from app.services import face_service
from tests.payment_helpers import b64, new_customer
from tests.synthetic_faces import sample_image
from tests.synthetic_scenes import GOOD_TURN, scene, sequence
from tests.test_model_readiness import GUIDED, challenge, enroll_guided, readiness, verify

pytestmark = pytest.mark.usefixtures("scene_detector")


def crops_for(identity: int, n: int) -> np.ndarray:
    return np.stack([crop_to_stored(sample_image(identity, i))[0] for i in range(n)])


# ---------------------------------------------------------------- augmentation


def test_augmentation_is_deterministic_and_only_perturbs_slightly():
    crops = crops_for(0, 6)
    a = augmented_vectors(crops, 3, seed=7)
    b = augmented_vectors(crops, 3, seed=7)
    c = augmented_vectors(crops, 3, seed=8)
    assert a.shape == (3, 6, cfg.IMAGE_SIZE * cfg.IMAGE_SIZE)
    assert np.array_equal(a, b)  # reproducible: the same samples always give the same model
    assert not np.array_equal(a, c)
    original = np.stack([vectorize(x) for x in crops])
    for k in range(3):
        for i in range(6):
            assert not np.allclose(a[k, i], original[i])  # it really is a different picture
            corr = np.corrcoef(a[k, i], original[i])[0, 1]
            assert corr > 0.5, corr  # but still the same face, not a new one


def test_a_copy_is_closer_to_its_own_source_than_to_another_person():
    mine, other = crops_for(0, 6), crops_for(1, 6)
    rng = np.random.default_rng(3)
    for i in range(6):
        copy = vectorize(augment_crop(mine[i], rng))
        assert np.linalg.norm(copy - vectorize(mine[i])) < np.linalg.norm(copy - vectorize(other[i]))


def test_augmented_set_has_independent_train_and_calibration_copies():
    s = AugmentedSet.build(crops_for(0, 4))
    assert len(s.train) == cfg.AUGMENT_COPIES and len(s.calib) == cfg.CALIBRATION_COPIES
    assert not np.array_equal(s.train[0], s.calib[0])


# ---------------------------------------------------------------- no leakage across the cross-validation split


def test_a_held_out_sample_and_its_copies_never_reach_the_training_side(monkeypatch):
    crops = np.concatenate([crops_for(0, 8), crops_for(1, 8)])
    y = np.array([0] * 8 + [1] * 8)
    X = np.stack([vectorize(c) for c in crops])
    aug = AugmentedSet.build(crops, train_copies=2, calib_copies=1)
    splits, _ = make_splits(y, None)
    fitted = []
    real_fit = FacePipeline.fit

    def spy(self, Xt, yt, **kwargs):
        fitted.append(np.asarray(Xt))
        return real_fit(self, Xt, yt, **kwargs)

    monkeypatch.setattr(FacePipeline, "fit", spy)
    evaluate_variant(dict(use_lda=True, classifier="knn"), X, y, splits, aug=aug)
    assert len(fitted) == len(splits)
    for (tr, te), Xt in zip(splits, fitted, strict=True):
        assert len(Xt) == len(tr) * (1 + 2)  # originals + 2 copies of the TRAINING samples only
        for i in te:
            for forbidden in (X[i], aug.train[0][i], aug.train[1][i], aug.calib[0][i]):
                assert not any(np.array_equal(row, forbidden) for row in Xt), "held-out data leaked into training"


def test_with_copies_keeps_copies_with_their_source():
    X = np.arange(12, dtype=float).reshape(4, 3)
    y = np.array([0, 0, 1, 1])
    copies = np.stack([X + 100, X + 200])
    Xo, yo = _with_copies(X, y, np.array([1, 3]), copies)
    assert Xo.shape == (6, 3) and list(yo) == [0, 1] * 3
    assert {tuple(r) for r in Xo} == {tuple(X[1]), tuple(X[3]), tuple(X[1] + 100), tuple(X[3] + 100), tuple(X[1] + 200), tuple(X[3] + 200)}


def test_accuracy_is_measured_on_originals_only():
    crops = np.concatenate([crops_for(0, 8), crops_for(1, 8)])
    y = np.array([0] * 8 + [1] * 8)
    X = np.stack([vectorize(c) for c in crops])
    aug = AugmentedSet.build(crops, train_copies=2, calib_copies=2)
    results, _, _ = compare_and_select(X, y, None, aug=aug)
    for r in results.values():
        assert r["n_evaluated"] == len(y)  # not len(y) * (1 + copies)
        assert len(r["_genuine_distances"]) == len(y) * (1 + 2)  # threshold calibration does include the perturbed held-out copies
        assert len(r["_genuine_labels"]) == len(r["_genuine_distances"])


# ---------------------------------------------------------------- per-user thresholds


def test_a_steadier_and_a_looser_user_get_their_own_thresholds():
    rng = np.random.default_rng(0)
    steady, loose = rng.normal(2.0, 0.2, 30), rng.normal(2.0, 1.0, 30).clip(0)
    d, labels = np.concatenate([steady, loose]), np.array([1] * 30 + [2] * 30)
    pooled, per_user = user_thresholds(d, labels, 90.0)
    assert per_user[2] > pooled > per_user[1]
    assert per_user[1] == pytest.approx(float(np.percentile(steady, 90)))


def test_a_user_with_too_few_distances_falls_back_to_the_pooled_threshold():
    d = np.concatenate([np.linspace(1, 3, 40), [9.0, 9.5]])
    labels = np.array([1] * 40 + [2] * 2)
    pooled, per_user = user_thresholds(d, labels, 90.0)
    assert per_user[2] == pooled and per_user[1] != pooled


def test_the_deployed_percentile_is_90_with_augmentation_and_the_mean_rule():
    assert cfg.DISTANCE_THRESHOLD_PERCENTILE == 90.0 and cfg.AUGMENT_COPIES >= 1 and cfg.AUTH_FRAME_DISTANCE_CAP > 1.0


# ---------------------------------------------------------------- training stores the new recipe


@pytest.fixture
def two_real(client):
    """Two customers with a complete guided setup and a model trained with the REAL calibrated thresholds (nothing overridden)."""
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll_guided(client, a, 0)
    enroll_guided(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    return a, b


def payload_of(db, uid):
    prof = db.scalar(select(FaceProfile).where(FaceProfile.user_id == uid, FaceProfile.status == "active"))
    version = db.scalar(select(ModelVersion.version).where(ModelVersion.id == prof.model_version_id))
    return json.loads(crypto.decrypt(prof.feature_data, f"face_profile:{uid}:{version}"))


def test_training_records_the_recipe_and_a_threshold_per_person(two_real, db):
    a, b = two_real
    row = registry.active_model_row(db)
    assert row.evaluation_metrics["recipe"] == cfg.MODEL_RECIPE
    assert row.evaluation_metrics["augment_copies"] == cfg.AUGMENT_COPIES
    assert row.n_samples == 30  # the model's sample count is the stored samples; copies are never stored
    assert db.scalar(select(func.count()).select_from(FaceSample)) == 30
    for u in (a, b):
        p = payload_of(db, u["id"])
        assert p["distance_threshold"] > 0 and p["pooled_threshold"] > 0 and 0.0 <= p["recall"] <= 1.0


def test_the_calibrated_threshold_accepts_the_owner_and_rejects_the_other_enrolled_person(client, two_real):
    a, _ = two_real
    owner = verify(client, a, challenge(client, a).json(), identity=0)
    assert owner["result"] == "AUTHENTICATED", owner
    other = verify(client, a, challenge(client, a).json(), identity=1)
    assert other["result"] == "REJECTED" and other["reason"] in ("IDENTITY_MISMATCH", "LOW_CONFIDENCE", "DISTANCE_TOO_HIGH")


def test_the_owner_is_accepted_when_the_second_capture_sits_differently_in_the_frame(client, two_real):
    """The production failure: a later session whose face box sits a little differently from enrolment."""
    a, _ = two_real
    ch = challenge(client, a).json()
    frames = [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN, y=85, size=108)]
    r = client.post("/face-auth/verify", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=a["headers"])
    assert r.status_code == 200 and r.json()["result"] == "AUTHENTICATED", r.json()


# ---------------------------------------------------------------- an older model is rebuilt from the stored samples


def make_outdated(db):
    row = registry.active_model_row(db)
    metrics = dict(row.evaluation_metrics)
    metrics["recipe"] = "v3-old"
    db.execute(update(ModelVersion).where(ModelVersion.id == row.id).values(evaluation_metrics=metrics))
    db.commit()
    registry.invalidate()
    return row.version


def test_an_outdated_model_is_retrained_from_the_stored_samples_without_any_new_capture(client, two_real, db):
    a, b = two_real
    old_version = make_outdated(db)
    assert face_service.recipe_outdated(registry.active_model_row(db))
    assert face_service.retrain_if_outdated(db) is True
    db.expire_all()
    row = registry.active_model_row(db)
    assert row.version != old_version and row.evaluation_metrics["recipe"] == cfg.MODEL_RECIPE
    assert db.scalar(select(func.count()).select_from(FaceSample)) == 30  # no sample was added, changed or removed
    assert db.scalar(select(func.count()).select_from(ModelVersion).where(ModelVersion.status == "active")) == 1
    for u in (a, b):
        assert readiness(client, u)["ready"] is True
    assert verify(client, a, challenge(client, a).json(), identity=0)["result"] == "AUTHENTICATED"
    assert face_service.retrain_if_outdated(db) is False  # current now: nothing to do


def test_a_current_model_is_left_alone(two_real, db):
    before = registry.active_model_row(db).version
    assert face_service.retrain_if_outdated(db) is False
    assert registry.active_model_row(db).version == before


def test_a_failed_retraining_keeps_the_existing_model_working(client, two_real, db, monkeypatch):
    a, _ = two_real
    old_version = make_outdated(db)

    def boom(*_a, **_k):
        raise RuntimeError("numerical failure")

    monkeypatch.setattr(recipe, "compare_and_select", boom)
    assert face_service.retrain_if_outdated(db) is False
    db.expire_all()
    assert registry.active_model_row(db).version == old_version
    assert readiness(client, a)["ready"] is True
    assert verify(client, a, challenge(client, a).json(), identity=0)["result"] in ("AUTHENTICATED", "REJECTED")  # still decides, no server error


def test_starting_a_face_check_schedules_the_retraining_in_the_background(client, two_real, db, monkeypatch):
    a, _ = two_real
    make_outdated(db)
    started = []

    class Inline:  # runs the "background" job at once so the test can look at the result
        def __init__(self, target, name=None, daemon=None):
            self.target = target

        def start(self):
            started.append(1)
            self.target()

    monkeypatch.setattr(face_service.threading, "Thread", Inline)
    monkeypatch.setattr(face_service, "_retrain_failed_at", 0.0)
    assert challenge(client, a).status_code == 200  # the check itself is never delayed or refused
    assert started == [1]
    db.expire_all()
    assert registry.active_model_row(db).evaluation_metrics["recipe"] == cfg.MODEL_RECIPE


def test_automatic_retraining_can_be_switched_off_and_does_not_repeat_straight_after_a_failure(client, two_real, db, monkeypatch):
    make_outdated(db)
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "auto_retrain_models", False)
    assert face_service.schedule_retrain(db) is False
    monkeypatch.setattr(get_settings(), "auto_retrain_models", True)
    monkeypatch.setattr(face_service.time, "monotonic", lambda: 1000.0)
    monkeypatch.setattr(face_service, "_retrain_failed_at", 900.0)  # failed 100 s ago: inside the back-off
    assert face_service.schedule_retrain(db) is False


# ---------------------------------------------------------------- two accounts that cannot be told apart


def enroll_offset(client, cust, identity, offset):
    for i in range(15):
        r = client.post("/faces/samples", json={"image_base64": b64(scene(identity, offset + i, x=120 + (i * 13) % 80)), "pose": GUIDED[i // 3]},
                        headers=cust["headers"])
        assert r.status_code == 201, r.text


def test_two_accounts_set_up_with_the_same_face_are_flagged_instead_of_failing_silently(client):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Asha Test")
    enroll_offset(client, a, 0, 0)
    enroll_offset(client, b, 0, 50)  # the same face, other captures
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    flags = [readiness(client, u)["separation"]["ok"] for u in (a, b)]
    assert False in flags, flags  # at least one of the two cannot be told apart from the other account


def test_two_different_people_are_not_flagged(two_real, client):
    a, b = two_real
    assert [readiness(client, u)["separation"]["ok"] for u in (a, b)] == [True, True]


def test_separation_is_unknown_without_a_model(client):
    a = new_customer(client, "Asha Rao")
    enroll_guided(client, a, 0)
    assert readiness(client, a)["separation"]["ok"] is None


# ---------------------------------------------------------------- the diagnostic log actually reaches the host's log


def test_the_face_logger_emits_info_so_a_failed_check_can_be_explained_from_the_host_log():
    import logging

    import app.main  # noqa: F401  (configures logging on import)

    log = logging.getLogger("facepay.face")
    assert log.isEnabledFor(logging.INFO)
    assert any(getattr(h, "_facepay", False) for h in logging.getLogger("facepay").handlers)


def test_a_check_writes_the_identity_scores_and_no_biometric_data(client, two_real, caplog):
    import logging

    a, _ = two_real
    caplog.set_level(logging.INFO, logger="facepay.face")
    verify(client, a, challenge(client, a).json(), identity=0)
    lines = [r.getMessage() for r in caplog.records if r.name == "facepay.face"]
    identity = [m for m in lines if m.startswith("identity user_id=")]
    assert identity and "confidence=" in identity[0] and "distance=" in identity[0] and "threshold=" in identity[0]
    assert any(m.startswith("liveness user_id=") for m in lines)
    text = "\n".join(lines).lower()
    for forbidden in ("base64", "bearer", "password", "jwt", "image"):
        assert forbidden not in text
