"""Shared builders for payment tests (real PostgreSQL, synthetic face frames)."""

import base64
import json

from sqlalchemy import select

from app.core import crypto
from app.ml import config as cfg
from app.models import FaceProfile, ModelVersion
from tests.conftest import STRONG_PASSWORD, unique_email
from tests.synthetic_scenes import GOOD_TURN, scene, sequence

POSES = list(cfg.POSES)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def new_customer(client, name="Test Customer"):
    email = unique_email("c")
    r = client.post("/auth/register", json={"name": name, "email": email, "password": STRONG_PASSWORD})
    assert r.status_code == 201
    tok = client.post("/auth/login", json={"email": email, "password": STRONG_PASSWORD}).json()["access_token"]
    return {"id": r.json()["id"], "name": name, "email": email, "headers": {"Authorization": f"Bearer {tok}"}}


def new_merchant(client, business="SuperGrocery"):
    email = unique_email("m")
    r = client.post("/auth/merchant/register", json={"name": "Owner", "business_name": business, "email": email, "password": STRONG_PASSWORD})
    assert r.status_code == 201
    tok = client.post("/auth/merchant/login", json={"email": email, "password": STRONG_PASSWORD}).json()["access_token"]
    return {"id": r.json()["id"], "email": email, "headers": {"Authorization": f"Bearer {tok}"}}


def enroll(client, cust, identity, n=12):
    for i in range(n):
        r = client.post("/faces/samples", json={"image_base64": b64(scene(identity, i, x=120 + (i * 13) % 80)), "pose": POSES[i % 4]},
                        headers=cust["headers"])
        assert r.status_code == 201, r.text


def set_threshold(db, user_ids, value):
    for uid in user_ids:
        prof = db.scalar(select(FaceProfile).where(FaceProfile.user_id == uid, FaceProfile.status == "active"))
        version = db.scalar(select(ModelVersion.version).where(ModelVersion.id == prof.model_version_id))
        ctx = f"face_profile:{uid}:{version}"
        data = json.loads(crypto.decrypt(prof.feature_data, ctx))
        data["distance_threshold"] = value
        prof.feature_data = crypto.encrypt(json.dumps(data).encode(), ctx)
    db.commit()


def create_session(client, merchant, amount="950.00", ref="SG-10492", **extra):
    r = client.post("/merchant/payment-sessions", json={"amount": amount, "order_reference": ref, **extra}, headers=merchant["headers"])
    assert r.status_code == 201, r.text
    return r.json()


def start(client, cust, sid):
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def authenticate(client, cust, sid, identity=0, moves=GOOD_TURN, **kw):
    """Challenge + frames of `identity` performing the requested turn. Returns the response (any status)."""
    ch = start(client, cust, sid)
    frames = [b64(f) for f in sequence(identity, ch["challenge"], moves, **kw)]
    return client.post(f"/payments/sessions/{sid}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=cust["headers"])


def authorize(client, cust, sid, identity=0):
    """A successful authentication; returns the one-time authorization token."""
    r = authenticate(client, cust, sid, identity)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["result"] == "AUTHENTICATED", body
    return body["authorization"]["authorization_token"]


def shown(client, cust, sid):
    """What the checkout screen shows the customer: the details they confirm."""
    r = client.get(f"/payments/sessions/{sid}", headers=cust["headers"])
    if r.status_code != 200:  # e.g. a disabled account cannot open checkout: the confirm call under test must still be refused
        return {"expected_amount": "1.00", "expected_merchant": "-", "expected_order_reference": ""}
    c = r.json()
    if c.get("kind") == "TRANSFER":
        return {"expected_amount": c["amount"], "expected_recipient": c["recipient_facepay_id"]}
    return {"expected_amount": c["amount"], "expected_merchant": c["merchant_name"], "expected_order_reference": c["order_reference"] or ""}


def confirm(client, cust, sid, token, **extra):
    """Confirm the way the UI does: with the amount, merchant and order the customer was shown (override to test mismatches)."""
    body = {"authorization_token": token, **shown(client, cust, sid), **extra}
    return client.post(f"/payments/sessions/{sid}/confirm", json=body, headers=cust["headers"])
