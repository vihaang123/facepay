"""Shared fixtures (registered in conftest.py) and builders for the customer-to-customer, request, QR, history and role tests.

Real PostgreSQL; face frames are synthetic (see synthetic_scenes.py); everything after the camera is the real code path.
`world` gives three customers: Asha (enrolled), Ravi (enrolled) and Chitra (no face profile, can only receive)."""

import pytest

from app.api import faces as faces_api
from app.main import app
from tests.payment_helpers import authorize, confirm, enroll, new_customer, new_merchant, set_threshold
from tests.synthetic_scenes import BackgroundBoxDetector


@pytest.fixture
def scene_detector():
    app.dependency_overrides[faces_api.get_detector] = lambda: BackgroundBoxDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


@pytest.fixture
def world(client, db):
    asha, ravi, chitra = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah"), new_customer(client, "Chitra Iyer")
    enroll(client, asha, 0)
    enroll(client, ravi, 1)
    assert client.post("/faces/train", headers=asha["headers"]).status_code == 200
    set_threshold(db, [asha["id"], ravi["id"]], 1000.0)
    for c in (asha, ravi, chitra):
        c["facepay_id"] = client.get("/facepay/me", headers=c["headers"]).json()["facepay_id"]
    return asha, ravi, chitra


@pytest.fixture
def shop(client):
    return new_merchant(client, "SuperGrocery")


def code(r):
    return r.json()["detail"]["code"]


def balance(client, cust):
    return client.get("/wallet", headers=cust["headers"]).json()["balance"]


def prepare(client, payer, to, amount="500.00", note=None, key=None):
    """Review step: prepares the payment. Returns the raw response."""
    body = {"recipient_facepay_id": to["facepay_id"] if isinstance(to, dict) else to, "amount": amount}
    if note is not None:
        body["note"] = note
    headers = dict(payer["headers"])
    if key:
        headers["Idempotency-Key"] = key
    return client.post("/transfers", json=body, headers=headers)


def prepared(client, payer, to, amount="500.00", note=None):
    r = prepare(client, payer, to, amount, note)
    assert r.status_code == 201, r.text
    return r.json()["session_id"]


def pay_transfer(client, payer, to, amount="500.00", note=None, identity=0):
    """Whole happy path for a transfer; returns the confirm response."""
    sid = prepared(client, payer, to, amount, note)
    token = authorize(client, payer, sid, identity=identity)
    return confirm(client, payer, sid, token)
