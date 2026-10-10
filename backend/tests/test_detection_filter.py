"""Face counting: one face is counted once however many boxes the detector drew, a weak second candidate is not a
person, and a real second person still is. The cascade is replaced by a stub that returns chosen boxes and confidences
(the real detector's behaviour on photographs is measured in ml/experiments/detection_evidence.py, not here)."""

import numpy as np
import pytest

from app.api import faces as faces_api
from app.main import app
from app.ml import config as cfg
from app.ml import preprocessing as pp
from app.ml.preprocessing import Box, HaarFaceDetector, distinct_faces
from tests.payment_helpers import b64, new_customer
from tests.synthetic_scenes import BackgroundBoxDetector, scene


class StubCascade:
    def __init__(self, found):
        self.found = found

    def detectMultiScale3(self, img, **kw):
        if not self.found:
            return (), (), ()
        rects = np.array([f[0] for f in self.found])
        return rects, np.zeros(len(self.found)), np.array([f[1] for f in self.found], dtype=float)


@pytest.fixture
def haar(monkeypatch):
    def use(found):
        monkeypatch.setattr(pp, "_face_cascade", lambda: StubCascade(found))
        return HaarFaceDetector()

    return use


GRAY = np.full((480, 640), 120, np.uint8)
MAIN = (100, 100, 200, 200)


def test_nothing_found_is_no_faces(haar):
    assert haar([]).detect(GRAY) == []


def test_overlapping_boxes_on_one_face_are_one_face(haar):
    weak_dup = (110, 105, 190, 195)  # heavily overlapping duplicate
    nested = (150, 160, 90, 90)  # nested inside the face
    assert haar([(MAIN, 9.0), (weak_dup, 8.0), (nested, 8.0)]).detect(GRAY) == [Box(*MAIN)]


def test_a_weak_second_candidate_is_not_a_person_but_the_main_face_is_always_kept(haar):
    far_box = (450, 100, 100, 100)
    assert haar([(MAIN, 9.0), (far_box, cfg.SECOND_FACE_MIN_WEIGHT - 0.5)]).detect(GRAY) == [Box(*MAIN)]
    assert haar([(MAIN, 1.0)]).detect(GRAY) == [Box(*MAIN)]  # even a low-confidence only candidate is kept


def test_a_real_second_person_is_still_two_faces(haar):
    far_box = (450, 100, 100, 100)
    boxes = haar([(MAIN, 9.0), (far_box, cfg.SECOND_FACE_MIN_WEIGHT + 1)]).detect(GRAY)
    assert boxes == [Box(*MAIN), Box(*far_box)]


def test_distinct_faces_keeps_the_largest_of_each_face_and_separate_people():
    a, a_dup, b = Box(0, 0, 100, 100), Box(5, 5, 95, 95), Box(400, 0, 80, 80)
    assert distinct_faces([a_dup, b, a]) == [a, b]
    assert distinct_faces([]) == []


def test_touching_neighbours_are_two_faces():
    assert len(distinct_faces([Box(0, 0, 100, 100), Box(100, 0, 100, 100)])) == 2  # side by side, no overlap


# ---------------------------------------------------------------- the live preview agrees with the decision


@pytest.fixture
def scene_detector():
    app.dependency_overrides[faces_api.get_detector] = lambda: BackgroundBoxDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


def test_assess_for_authentication_uses_the_authentication_second_face_rule(client, scene_detector):
    """A second face 17% of the main face's area passes the enrolment rule (40%) but blocks authentication (15%): the
    preview used by the authentication screen must say so, not claim one face is in view."""
    c = new_customer(client)
    image = b64(scene(0, 1, extra=[(1, 5, 10, 10, 40)]))
    enrol = client.post("/faces/assess", json={"image_base64": image}, headers=c["headers"]).json()
    auth = client.post("/faces/assess?purpose=auth", json={"image_base64": image}, headers=c["headers"]).json()
    assert enrol["state"] == "OK" and enrol["faces"] == 1
    assert auth["state"] == "MULTIPLE_FACES" and auth["faces"] == 2


def test_assess_rejects_an_unknown_purpose(client, scene_detector):
    c = new_customer(client)
    r = client.post("/faces/assess?purpose=payment", json={"image_base64": b64(scene(0, 1))}, headers=c["headers"])
    assert r.status_code == 422
