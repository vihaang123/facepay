"""The deep-embedding engine (FACE_ENGINE=embedding): enrolment, payment authentication, find-by-face (1:N), and the guarantee
that the default engine is untouched.

The real network (dlib ResNet) needs real photographs, which the repository does not contain, so these tests plug in a stand-in
embedder that turns the synthetic scenes into 128 numbers. Everything else is the production code over real PostgreSQL:
enrolment storage, encryption, the reference, thresholds, the decision policy, liveness, tickets, opt-in and payment
confirmation. How well the real network separates real people is measured separately (ml/experiments/embedding_benchmark.py).
These are automated tests, not a hosted run."""

import cv2
import numpy as np
import pytest

from app.core.config import get_settings
from app.ml import embedding as emb
from app.ml.preprocessing import MULTIPLE_FACES, NO_FACE, FaceImageError
from tests.payment_helpers import authenticate, authorize, b64, confirm, create_session, enroll, new_customer, new_merchant
from tests.synthetic_scenes import BG, empty_scene, scene

pytestmark = pytest.mark.usefixtures("scene_detector")


class SceneEmbedder:
    """Stand-in for the network: the face box of a synthetic scene -> 12x12 -> standardised -> fixed random projection to 128
    numbers, scaled so that one identity lands ~0.2 apart and different identities ~0.57 apart (the real network's scale)."""

    def __init__(self):
        self.proj = np.random.default_rng(5).normal(size=(144, emb.cfg.EMBED_DIM))

    def embed(self, gray, *, second_face_ratio=0.4):
        n, _, stats, _ = cv2.connectedComponentsWithStats((gray != BG).astype(np.uint8))
        boxes = sorted((s for s in stats[1:] if s[4] >= 400), key=lambda s: -s[4])
        if not boxes:
            raise FaceImageError(NO_FACE, "No face was found.")
        if len(boxes) > 1 and boxes[1][4] >= second_face_ratio * boxes[0][4]:
            raise FaceImageError(MULTIPLE_FACES, "More than one face.")
        x, y, w, h, _ = boxes[0]
        crop = cv2.resize(gray[y : y + h, x : x + w].astype(np.float32), (12, 12), interpolation=cv2.INTER_AREA)
        crop = (crop - crop.mean()) / (crop.std() or 1.0)
        v = crop.ravel() @ self.proj
        return (0.4 * v / np.linalg.norm(v)).astype(np.float32)


class NoFaceEmbedder:
    def embed(self, gray, *, second_face_ratio=0.4):
        raise FaceImageError(NO_FACE, "No face was found.")


@pytest.fixture
def engine(monkeypatch):
    monkeypatch.setattr(get_settings(), "face_engine", "embedding")
    emb.set_embedder(SceneEmbedder())
    yield
    emb.set_embedder(None)


def readiness(client, cust):
    r = client.get("/faces/readiness", headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def opt_in(client, cust):
    assert client.put("/security/face-lookup", json={"enabled": True}, headers=cust["headers"]).status_code == 200


def frames(identity, start_var=300, n=3, extra=None):
    return [b64(scene(identity, start_var + i, x=150 + i, extra=extra)) for i in range(n)]


def look(client, actor, identity, **kw):
    return client.post("/face-lookup", json={"frames": frames(identity, **kw)}, headers=actor["headers"]).json()


def test_the_default_engine_is_unchanged():
    assert get_settings().face_engine == "pca_lda"


def test_one_customer_is_enough_no_training_needed(client, engine):
    asha = new_customer(client, "Asha Rao")
    assert readiness(client, asha)["ready"] is False
    enroll(client, asha, 0)
    r = readiness(client, asha)
    assert r["ready"] is True and r["model_version"] == "dlib-resnet-v1" and r["checks"]["people_with_finished_setup"]["enough"] is True
    summary = client.post("/faces/train", headers=asha["headers"])  # kept for the app's setup flow; it just confirms the reference
    assert summary.status_code == 200 and summary.json()["version"] == "dlib-resnet-v1" and summary.json()["includes_you"] is True
    assert client.get("/faces/model", headers=asha["headers"]).json()["model"]["version"] == "dlib-resnet-v1"


def test_a_customer_pays_with_their_own_face(client, engine):
    asha, shop = new_customer(client, "Asha Rao"), new_merchant(client, "SuperGrocery")
    enroll(client, asha, 0)
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, asha, sid, identity=0)
    paid = confirm(client, asha, sid, token)
    assert paid.status_code == 200 and paid.json()["status"] == "SUCCESS"


def test_someone_elses_face_cannot_pay_from_my_account(client, engine):
    asha, shop = new_customer(client, "Asha Rao"), new_merchant(client, "SuperGrocery")
    enroll(client, asha, 0)
    sid = create_session(client, shop)["session_id"]
    body = authenticate(client, asha, sid, identity=7).json()  # a different (never enrolled) face
    assert body["result"] == "REJECTED" and body["authorization"] is None
    assert body["reason"] in ("DISTANCE_TOO_HIGH", "LOW_CONFIDENCE", "IDENTITY_MISMATCH")


def test_an_authorization_from_one_engine_is_not_honoured_by_the_other(client, engine, monkeypatch):
    asha, shop = new_customer(client, "Asha Rao"), new_merchant(client, "SuperGrocery")
    enroll(client, asha, 0)
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, asha, sid, identity=0)
    monkeypatch.setattr(get_settings(), "face_engine", "pca_lda")  # the engine changed after the face check
    assert confirm(client, asha, sid, token).status_code in (403, 409)


def test_enrolment_is_refused_when_the_network_finds_no_face(client, engine):
    emb.set_embedder(NoFaceEmbedder())
    asha = new_customer(client, "Asha Rao")
    r = client.post("/faces/samples", json={"image_base64": b64(scene(0, 1)), "pose": "neutral"}, headers=asha["headers"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NO_FACE"


def test_samples_from_before_the_switch_do_not_count(client, monkeypatch):
    asha = new_customer(client, "Asha Rao")
    enroll(client, asha, 0)  # taken under the default engine: crops only, no embeddings
    monkeypatch.setattr(get_settings(), "face_engine", "embedding")
    emb.set_embedder(SceneEmbedder())
    try:
        r = readiness(client, asha)
        assert r["ready"] is False and r["code"] == "ENROLLMENT_INSUFFICIENT" and r["checks"]["samples"]["have"] == 0
        for i in range(12):  # repeating setup under the new engine (fresh frames, not replays of the old ones) makes them ready
            r = client.post("/faces/samples", json={"image_base64": b64(scene(0, 100 + i, x=130 + (i * 11) % 70)), "pose": ["neutral", "turn_left", "turn_right", "chin_up"][i % 4]}, headers=asha["headers"])
            assert r.status_code == 201, r.text
        assert readiness(client, asha)["ready"] is True
    finally:
        emb.set_embedder(None)


def test_deleting_face_data_removes_the_reference(client, engine):
    asha = new_customer(client, "Asha Rao")
    enroll(client, asha, 0)
    assert readiness(client, asha)["ready"] is True
    assert client.delete("/faces/samples", headers=asha["headers"]).status_code == 204
    assert readiness(client, asha)["ready"] is False
    opt_in(client, asha)
    other = new_customer(client, "Ravi Shah")
    r = client.post("/face-lookup", json={"frames": frames(0)}, headers=other["headers"])
    assert r.status_code == 503  # nobody is enrolled any more, so there is nothing to find


@pytest.fixture
def three(client, engine):
    """Asha (face 0) and Ravi (face 1) enrolled and opted in; Kabir (face 2) enrolled but NOT opted in; a requester with no face."""
    asha, ravi, kabir, req = (new_customer(client, n) for n in ("Asha Rao", "Ravi Shah", "Kabir Khan", "Shop Requester"))
    for cust, ident in ((asha, 0), (ravi, 1), (kabir, 2)):
        enroll(client, cust, ident)
    opt_in(client, asha)
    opt_in(client, ravi)
    return asha, ravi, kabir, req


def test_a_scan_finds_the_right_customer_among_many(client, three):
    asha, ravi, _, req = three
    a, r = look(client, req, 0), look(client, req, 1)
    assert a["matched"] and a["person"]["display_name"] == "Asha Rao" and a["lookup_token"].startswith("fl_")
    assert r["matched"] and r["person"]["display_name"] == "Ravi Shah"


def test_a_customer_who_did_not_opt_in_looks_like_nobody(client, three):
    _, _, _, req = three
    body = look(client, req, 2)  # Kabir is enrolled but not opted in
    assert body["matched"] is False and body["reason"] == "NO_MATCH" and body["person"] is None and body["lookup_token"] is None


def test_a_stranger_is_not_found(client, three):
    _, _, _, req = three
    for ident in (9, 10, 11):
        assert look(client, req, ident)["matched"] is False


def test_scanning_yourself_is_said_plainly(client, three):
    asha, _, _, _ = three
    assert look(client, asha, 0)["reason"] == "SELF"


def test_frames_of_different_people_do_not_match(client, three):
    _, _, _, req = three
    mixed = [b64(scene(0, 301, x=150)), b64(scene(1, 302, x=151)), b64(scene(2, 303, x=152))]
    body = client.post("/face-lookup", json={"frames": mixed}, headers=req["headers"]).json()
    assert body["matched"] is False


def test_camera_problems_are_explained(client, three):
    _, _, _, req = three
    assert client.post("/face-lookup", json={"frames": [b64(empty_scene())] * 3}, headers=req["headers"]).json()["reason"] == "CAMERA_NO_FACE"
    crowd = look(client, req, 0, extra=[(1, 5, 20, 70, 96)])
    assert crowd["matched"] is False and crowd["reason"] == "CAMERA_MULTIPLE_FACES"


def test_a_lookalike_of_a_non_opted_in_customer_cannot_borrow_an_opted_in_face(client, engine, monkeypatch):
    """The search covers every enrolled customer, not only the opted-in ones: a face that is closest to Kabir (not opted in) is
    never reported as someone else just because that someone is the closest opted-in face."""
    asha, kabir, req = (new_customer(client, n) for n in ("Asha Rao", "Kabir Khan", "Shop Requester"))
    enroll(client, asha, 0)
    enroll(client, kabir, 2)
    opt_in(client, asha)
    assert look(client, req, 2)["matched"] is False


def test_the_scan_ticket_works_once_for_a_request(client, three):
    asha, _, _, req = three
    token = look(client, req, 0)["lookup_token"]
    ask = {"lookup_token": token, "amount": "250.00", "purpose": "GOODS", "note": "Order 14 groceries"}
    first = client.post("/requests", json=ask, headers=req["headers"])
    assert first.status_code == 201 and first.json()["source"] == "FACE"
    assert client.post("/requests", json=ask, headers=req["headers"]).status_code == 404
    shown_to = client.get("/requests/incoming/prompts", headers=asha["headers"]).json()
    assert [i["note"] if "note" in i else i.get("reference") for i in shown_to] == ["Order 14 groceries"]


def test_nothing_is_found_before_anyone_has_finished_setup(client, engine):
    req = new_customer(client, "Shop Requester")
    r = client.post("/face-lookup", json={"frames": frames(0)}, headers=req["headers"])
    assert r.status_code == 503 and r.json()["detail"]["code"] == "LOOKUP_UNAVAILABLE"
