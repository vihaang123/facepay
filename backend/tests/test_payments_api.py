"""Simulated FacePay payments against the real PostgreSQL test database.

The face frames are synthetic (see synthetic_scenes.py), but everything after the camera is real: Phase 3 PCA/LDA,
Phase 4 liveness + policy, the authorization ticket, the atomic confirmation and the transaction rows."""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text, update

from app.api import faces as faces_api
from app.core.config import get_settings
from app.main import app
from app.models import AuthenticationLog, PaymentAuthorization, PaymentSession, Transaction, User
from app.services import payment_service as svc
from tests.payment_helpers import (
    authenticate,
    authorize,
    confirm,
    create_session,
    enroll,
    new_customer,
    new_merchant,
    set_threshold,
    start,
)
from tests.synthetic_scenes import BackgroundBoxDetector, empty_scene

TTL = get_settings().payment_authorization_ttl_seconds


@pytest.fixture(autouse=True)
def scene_detector():
    app.dependency_overrides[faces_api.get_detector] = lambda: BackgroundBoxDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


@pytest.fixture
def trained(client, db):
    """Customers Asha (face 0) and Ravi (face 1), trained through the API. The distance threshold is opened up so
    these tests exercise the payment logic, not which synthetic frame lands over the 70th-percentile cut-off
    (the threshold itself is covered in test_face_auth_api.py)."""
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll(client, a, 0)
    enroll(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    set_threshold(db, [a["id"], b["id"]], 1000.0)
    return a, b


@pytest.fixture
def shop(client):
    return new_merchant(client, "SuperGrocery")


def txn_count(db):
    db.expire_all()
    return db.scalar(select(func.count()).select_from(Transaction))


def session_row(db, sid):
    db.expire_all()
    return db.scalar(select(PaymentSession).where(PaymentSession.session_id == sid))


def auth_rows(db):
    db.expire_all()
    return list(db.scalars(select(PaymentAuthorization).order_by(PaymentAuthorization.id)))


def code(r):
    return r.json()["detail"]["code"]


# ============================================================ merchant: payment sessions


def test_merchant_creates_a_payment_session(client, shop):
    r = client.post("/merchant/payment-sessions", json={"amount": "950", "order_reference": " SG-10492 ", "description": "Groceries"},
                    headers=shop["headers"])
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["status"] == "CREATED" and Decimal(s["amount"]) == Decimal("950.00") and s["currency"] == "INR"
    assert s["order_reference"] == "SG-10492" and s["description"] == "Groceries" and s["transaction_id"] is None
    assert re.fullmatch(r"ps_[A-Za-z0-9_-]{20,}", s["session_id"]) and s["checkout_path"] == f"/checkout/{s['session_id']}"
    exp = datetime.fromisoformat(s["expires_at"])
    assert timedelta(minutes=14) < exp - datetime.now(UTC) <= timedelta(minutes=15, seconds=5)


def test_session_ids_are_unique_and_unguessable(client, shop):
    ids = {create_session(client, shop)["session_id"] for _ in range(5)}
    assert len(ids) == 5


@pytest.mark.parametrize(
    "body",
    [
        {"amount": "0", "order_reference": "X"},
        {"amount": "-5", "order_reference": "X"},
        {"amount": "10.999", "order_reference": "X"},
        {"amount": "1000000.01", "order_reference": "X"},
        {"amount": "abc", "order_reference": "X"},
        {"amount": "10"},
        {"amount": "10", "order_reference": "   "},
        {"amount": "10", "order_reference": "x" * 81},
        {"amount": "10", "order_reference": "X", "expires_in_minutes": 0},
        {"amount": "10", "order_reference": "X", "expires_in_minutes": 61},
        {"amount": "10", "order_reference": "X", "status": "PAID"},
        {"amount": "10", "order_reference": "X", "merchant_id": 99},
    ],
)
def test_invalid_session_requests_are_rejected(client, shop, body, db):
    assert client.post("/merchant/payment-sessions", json=body, headers=shop["headers"]).status_code == 422
    assert db.scalar(select(func.count()).select_from(PaymentSession)) == 0


def test_merchant_endpoints_need_a_merchant_token(client, trained, shop):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    for method, path in [("post", "/merchant/payment-sessions"), ("get", "/merchant/payment-sessions"), ("get", f"/merchant/payment-sessions/{sid}"),
                         ("post", f"/merchant/payment-sessions/{sid}/cancel"), ("get", "/merchant/transactions"), ("get", "/merchant/summary")]:
        kw = {"json": {"amount": "5", "order_reference": "X"}} if method == "post" and path.endswith("sessions") else {}
        assert getattr(client, method)(path, **kw).status_code == 401
        assert getattr(client, method)(path, headers=a["headers"], **kw).status_code == 403


def test_merchant_reads_lists_and_cancels_own_sessions(client, shop):
    s1, s2 = create_session(client, shop, ref="A-1"), create_session(client, shop, ref="A-2")
    assert client.get(f"/merchant/payment-sessions/{s1['session_id']}", headers=shop["headers"]).json()["order_reference"] == "A-1"
    listed = client.get("/merchant/payment-sessions", headers=shop["headers"]).json()
    assert [x["order_reference"] for x in listed] == ["A-2", "A-1"]  # newest first
    r = client.post(f"/merchant/payment-sessions/{s2['session_id']}/cancel", headers=shop["headers"])
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"
    only = client.get("/merchant/payment-sessions?status=CANCELLED", headers=shop["headers"]).json()
    assert [x["session_id"] for x in only] == [s2["session_id"]]
    assert client.get("/merchant/payment-sessions?status=BOGUS", headers=shop["headers"]).status_code == 422
    again = client.post(f"/merchant/payment-sessions/{s2['session_id']}/cancel", headers=shop["headers"])
    assert again.status_code == 409 and code(again) == "SESSION_NOT_CANCELLABLE"


# ============================================================ customer checkout


def test_customer_opens_checkout_and_sees_only_what_they_need(client, trained, shop):
    a, _ = trained
    s = create_session(client, shop, description="Weekly shop")
    r = client.get(f"/payments/sessions/{s['session_id']}", headers=a["headers"])
    assert r.status_code == 200
    v = r.json()
    assert v["merchant_name"] == "SuperGrocery" and v["order_reference"] == "SG-10492" and Decimal(v["amount"]) == Decimal("950.00")
    assert v["status"] == "CREATED" and v["currency"] == "INR" and v["attempts_remaining"] == v["max_auth_attempts"] == svc.max_auth_failures()
    assert shop["email"] not in r.text and "merchant_id" not in v and "password" not in r.text


def test_checkout_unknown_session_and_wrong_roles(client, trained, shop):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    assert client.get("/payments/sessions/ps_does-not-exist", headers=a["headers"]).status_code == 404
    assert client.get(f"/payments/sessions/{sid}").status_code == 401
    assert client.get(f"/payments/sessions/{sid}", headers=shop["headers"]).status_code == 403  # merchants do not check out


# ============================================================ the full flow


def test_full_flow_merchant_to_receipt_to_both_dashboards(client, trained, shop, db):
    a, _ = trained
    s = create_session(client, shop)
    sid = s["session_id"]

    r = authenticate(client, a, sid, identity=0)
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["result"] == "AUTHENTICATED" and res["liveness"] == "PASSED" and res["session_status"] == "AUTHENTICATED"
    assert res["identity"]["name"] == "Asha Rao" and res["authorization"]["expires_in_seconds"] == TTL
    token = res["authorization"]["authorization_token"]
    assert session_row(db, sid).status == "AUTHENTICATED"
    assert client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()["status"] == "AUTHENTICATED"

    # The ticket is stored hashed, tied to the customer, the session and the authentication log row; no biometrics.
    (row,) = auth_rows(db)
    assert row.token_hash != token and token not in row.token_hash and len(row.token_hash) == 64
    assert (row.user_id, row.status, row.consumed_at) == (a["id"], "ACTIVE", None)
    assert row.payment_session_id == session_row(db, sid).id
    log = db.get(AuthenticationLog, res["authentication_id"])
    assert row.authentication_log_id == log.id and log.result == "SUCCESS" and log.user_id == a["id"]
    assert {c.name for c in PaymentAuthorization.__table__.columns}.isdisjoint({"feature_data", "crop_encrypted", "image", "centroid"})

    r = confirm(client, a, sid, token, expected_amount="950.00")
    assert r.status_code == 200, r.text
    rec = r.json()
    assert re.fullmatch(r"FP-[0-9A-HJKMNP-TV-Z]{10}", rec["transaction_id"])
    assert (rec["status"], rec["payment_method"], rec["payer_name"], rec["merchant_name"], rec["order_reference"], rec["session_id"]) == \
           ("SUCCESS", "FACE_PAY", "Asha Rao", "SuperGrocery", "SG-10492", sid)
    assert Decimal(rec["amount"]) == Decimal("950.00") and rec["currency"] == "INR" and rec["timestamp"]

    db.expire_all()
    (txn,) = db.scalars(select(Transaction)).all()
    assert (txn.payer_id, txn.merchant_id, txn.payment_session_id, txn.payment_method, txn.status) == (a["id"], shop["id"], row.payment_session_id, "FACE_PAY", "SUCCESS")
    assert txn.amount == Decimal("950.00") and txn.transaction_id == rec["transaction_id"]
    assert auth_rows(db)[0].status == "CONSUMED" and auth_rows(db)[0].consumed_at is not None
    assert session_row(db, sid).status == "PAID"

    # customer dashboard + receipt
    mine = client.get("/payments/transactions", headers=a["headers"]).json()
    assert [t["transaction_id"] for t in mine] == [rec["transaction_id"]]
    assert (mine[0]["merchant_name"], mine[0]["order_reference"], mine[0]["status"]) == ("SuperGrocery", "SG-10492", "SUCCESS")
    assert client.get(f"/payments/transactions/{rec['transaction_id']}", headers=a["headers"]).json() == rec

    # merchant dashboard
    theirs = client.get("/merchant/transactions", headers=shop["headers"]).json()
    assert [t["transaction_id"] for t in theirs] == [rec["transaction_id"]] and theirs[0]["payer_name"] == "Asha Rao"
    assert "email" not in theirs[0] and "payer_id" not in theirs[0]
    assert client.get(f"/merchant/transactions/{rec['transaction_id']}", headers=shop["headers"]).json() == rec
    ms = client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()
    assert ms["status"] == "PAID" and ms["transaction_id"] == rec["transaction_id"]
    sm = client.get("/merchant/summary", headers=shop["headers"]).json()
    assert (Decimal(sm["total_revenue"]), sm["transactions"], sm["successful_payments"], sm["failed_payments"], sm["open_sessions"]) == (Decimal("950.00"), 1, 1, 0, 0)
    assert len(sm["revenue_by_day"]) == 14 and Decimal(sm["revenue_by_day"][-1]["revenue"]) == Decimal("950.00") and sm["revenue_by_day"][-1]["count"] == 1
    assert sum(Decimal(d["revenue"]) for d in sm["revenue_by_day"]) == Decimal("950.00")


def test_transaction_ids_are_unique_across_payments(client, trained, shop):
    a, _ = trained
    ids = set()
    for i in range(3):
        sid = create_session(client, shop, ref=f"O-{i}")["session_id"]
        ids.add(confirm(client, a, sid, authorize(client, a, sid)).json()["transaction_id"])
    assert len(ids) == 3


# ============================================================ authorization security


def test_reused_authorization_cannot_pay_again(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    assert confirm(client, a, sid, token).status_code == 200
    again = confirm(client, a, sid, token)
    assert again.status_code == 409 and code(again) == "SESSION_ALREADY_PAID"
    assert txn_count(db) == 1


def test_consumed_authorization_is_refused_even_if_session_state_were_tampered_with(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    assert confirm(client, a, sid, token).status_code == 200
    db.execute(update(PaymentSession).where(PaymentSession.session_id == sid).values(status="AUTHENTICATED"))
    db.commit()
    r = confirm(client, a, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_USED"
    assert txn_count(db) == 1


def test_expired_authorization_is_rejected(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    db.execute(update(PaymentAuthorization).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    r = confirm(client, a, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_EXPIRED"
    assert txn_count(db) == 0 and auth_rows(db)[0].status == "EXPIRED"
    # the session falls back to "waiting" and a fresh authentication works
    assert client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()["status"] == "CREATED"
    assert confirm(client, a, sid, authorize(client, a, sid)).status_code == 200


def test_authorization_lives_only_as_long_as_the_configured_ttl(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    authorize(client, a, sid)
    (row,) = auth_rows(db)
    life = (row.expires_at - row.created_at).total_seconds()
    assert TTL - 5 <= life <= TTL + 5 and TTL <= 180


def test_wrong_customer_cannot_use_someone_elses_authorization(client, trained, shop, db):
    a, b = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    r = confirm(client, b, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txn_count(db) == 0 and auth_rows(db)[0].status == "ACTIVE"  # not consumed by the attacker
    ok = confirm(client, a, sid, token)  # the rightful owner can still pay
    assert ok.status_code == 200 and ok.json()["payer_name"] == "Asha Rao"


def test_other_customer_cannot_authenticate_as_the_owner_of_a_session(client, trained, shop):
    """Face authentication is always of the logged-in customer: B showing A's face does not become A."""
    _, b = trained
    sid = create_session(client, shop)["session_id"]
    res = authenticate(client, b, sid, identity=0).json()  # Ravi's account, Asha's face
    assert res["result"] == "REJECTED" and res["reason"] == "IDENTITY_MISMATCH" and res["authorization"] is None


def test_authorization_for_one_session_cannot_pay_another(client, trained, shop, db):
    a, _ = trained
    s1, s2 = create_session(client, shop, ref="S1")["session_id"], create_session(client, shop, ref="S2")["session_id"]
    token = authorize(client, a, s1)
    r = confirm(client, a, s2, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txn_count(db) == 0 and session_row(db, s2).status == "CREATED"
    assert confirm(client, a, s1, token).status_code == 200


def test_unknown_or_forged_authorization_is_rejected(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    for token in ["x" * 43, "A" * 20, "0" * 64]:
        r = confirm(client, a, sid, token)
        assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    # the stored hash is not itself a credential
    authorize(client, a, sid)
    stored = auth_rows(db)[0].token_hash
    assert confirm(client, a, sid, stored).status_code == 403
    assert txn_count(db) == 0


def test_the_client_cannot_claim_it_is_authenticated(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    for body in [{}, {"authenticated": True}, {"authorization_token": "x" * 30, "authenticated": True}, {"authorization_token": "short"}]:
        r = client.post(f"/payments/sessions/{sid}/confirm", json=body, headers=a["headers"])
        assert r.status_code == 422
    # a successful *generic* face authentication does not unlock a payment either
    ch = client.post("/face-auth/challenge", headers=a["headers"]).json()
    from tests.payment_helpers import b64
    from tests.synthetic_scenes import GOOD_TURN, sequence
    r = client.post("/face-auth/verify", json={"challenge_id": ch["challenge_id"], "frames": [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN)]}, headers=a["headers"])
    assert r.json()["result"] == "AUTHENTICATED" and "authorization" not in r.json()
    assert auth_rows(db) == [] and txn_count(db) == 0
    assert session_row(db, sid).status == "CREATED"


def test_a_failed_attempt_never_produces_an_authorization(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    res = authenticate(client, a, sid, identity=0, moves=[0.0] * 5).json()  # no head movement
    assert res["result"] == "REJECTED" and res["reason"] == "LIVENESS_FAILED" and res["authorization"] is None
    assert auth_rows(db) == [] and res["session_status"] == "CREATED"


# ============================================================ amount manipulation


def test_amount_manipulation_is_rejected_and_the_session_amount_is_charged(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="950")["session_id"]
    token = authorize(client, a, sid)

    r = confirm(client, a, sid, token, expected_amount="1")
    assert r.status_code == 409 and code(r) == "AMOUNT_MISMATCH"
    assert txn_count(db) == 0 and auth_rows(db)[0].status == "ACTIVE"

    # unknown fields such as amount are not accepted at all
    for field in ("amount", "price", "total"):
        assert confirm(client, a, sid, token, **{field: "1"}).status_code == 422
    assert txn_count(db) == 0

    ok = confirm(client, a, sid, token)  # no expected_amount: still the session's amount
    assert ok.status_code == 200 and Decimal(ok.json()["amount"]) == Decimal("950.00")
    db.expire_all()
    assert db.scalar(select(Transaction.amount)) == Decimal("950.00")


def test_changing_the_amount_in_the_database_between_display_and_confirm_is_caught(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="950")["session_id"]
    token = authorize(client, a, sid)
    db.execute(update(PaymentSession).values(amount=Decimal("1200.00")))
    db.commit()
    assert code(confirm(client, a, sid, token, expected_amount="950.00")) == "AMOUNT_MISMATCH"
    # The authorization was issued for 950.00: it is worthless for a session that now says 1200.00, even when the
    # customer confirms the new figure. They must authenticate again for the amount they are really paying.
    r = confirm(client, a, sid, token, expected_amount="1200.00")
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txn_count(db) == 0
    token2 = authorize(client, a, sid)
    assert Decimal(confirm(client, a, sid, token2).json()["amount"]) == Decimal("1200.00")


# ============================================================ session state


def test_a_paid_session_cannot_be_paid_again(client, trained, shop, db):
    a, b = trained
    sid = create_session(client, shop)["session_id"]
    assert confirm(client, a, sid, authorize(client, a, sid)).status_code == 200
    for cust in (a, b):
        r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=cust["headers"])
        assert r.status_code == 409 and code(r) == "SESSION_ALREADY_PAID"
    r = authenticate_raw(client, a, sid)
    assert r.status_code == 409 and code(r) == "SESSION_ALREADY_PAID"
    assert txn_count(db) == 1
    assert client.get(f"/payments/sessions/{sid}", headers=a["headers"]).json()["status"] == "PAID"


def authenticate_raw(client, cust, sid):
    """Authenticate without first asking for a payable challenge (e.g. a stale browser tab)."""
    from tests.payment_helpers import b64
    from tests.synthetic_scenes import GOOD_TURN, sequence
    ch = client.post("/face-auth/challenge", headers=cust["headers"]).json()
    frames = [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN)]
    return client.post(f"/payments/sessions/{sid}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=cust["headers"])


def test_cancelled_session_cannot_be_paid_and_revokes_a_live_authorization(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    assert client.post(f"/merchant/payment-sessions/{sid}/cancel", headers=shop["headers"]).json()["status"] == "CANCELLED"
    assert auth_rows(db)[0].status == "REVOKED"
    r = confirm(client, a, sid, token)
    assert r.status_code == 409 and code(r) == "SESSION_CANCELLED"
    assert client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"]).status_code == 409
    assert authenticate_raw(client, a, sid).status_code == 409
    assert txn_count(db) == 0


def test_expired_session_cannot_be_paid(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    db.execute(update(PaymentSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    assert client.get(f"/payments/sessions/{sid}", headers=a["headers"]).json()["status"] == "EXPIRED"
    r = confirm(client, a, sid, token)
    assert r.status_code == 409 and code(r) == "SESSION_EXPIRED"
    assert client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"]).status_code == 409
    assert client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()["status"] == "EXPIRED"
    assert txn_count(db) == 0 and auth_rows(db)[0].status in ("EXPIRED", "REVOKED")


def test_session_expiring_while_the_camera_is_running_still_issues_nothing(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    ch = start(client, a, sid)
    db.execute(update(PaymentSession).values(status="CANCELLED"))
    db.commit()
    from tests.payment_helpers import b64
    from tests.synthetic_scenes import GOOD_TURN, sequence
    frames = [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN)]
    r = client.post(f"/payments/sessions/{sid}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=a["headers"])
    assert r.status_code == 409 and code(r) == "SESSION_CANCELLED"
    assert auth_rows(db) == []


def test_repeated_rejections_fail_the_session(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    for n in range(1, svc.max_auth_failures()):
        res = authenticate(client, a, sid, identity=1).json()  # a stranger's face
        assert res["result"] == "REJECTED" and res["session_status"] == "CREATED" and res["attempts_remaining"] == svc.max_auth_failures() - n
    last = authenticate(client, a, sid, identity=1).json()
    assert last["session_status"] == "FAILED" and last["attempts_remaining"] == 0 and last["authorization"] is None
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"])
    assert r.status_code == 409 and code(r) == "SESSION_FAILED"
    assert client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()["status"] == "FAILED"
    sm = client.get("/merchant/summary", headers=shop["headers"]).json()
    assert sm["failed_payments"] == 1 and sm["successful_payments"] == 0 and Decimal(sm["total_revenue"]) == 0
    # every attempt was still logged by the Phase 4 log
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AuthenticationLog).where(AuthenticationLog.user_id == a["id"], AuthenticationLog.result == "FAILED")) == svc.max_auth_failures()


def test_camera_problems_do_not_count_against_the_session(client, trained, shop):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    from tests.payment_helpers import b64
    ch = start(client, a, sid)
    frames = [b64(empty_scene()) for _ in range(6)]
    res = client.post(f"/payments/sessions/{sid}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=a["headers"]).json()
    assert res["reason"] == "FACE_NOT_DETECTED" and res["attempts_remaining"] == svc.max_auth_failures() and res["session_status"] == "CREATED"


def test_genuine_customer_recovers_after_a_rejection(client, trained, shop):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    assert authenticate(client, a, sid, identity=0, moves=[0.0] * 5).json()["result"] == "REJECTED"
    token = authorize(client, a, sid)
    assert confirm(client, a, sid, token).status_code == 200


def test_new_authentication_revokes_the_previous_authorization(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    first, second = authorize(client, a, sid), authorize(client, a, sid)
    assert [r.status for r in auth_rows(db)] == ["REVOKED", "ACTIVE"]
    assert code(confirm(client, a, sid, first)) == "AUTHORIZATION_INVALID"
    assert confirm(client, a, sid, second).status_code == 200


def test_disabled_account_cannot_authenticate_or_confirm(client, trained, shop, db):
    a, _ = trained
    s1, s2 = create_session(client, shop, ref="D1")["session_id"], create_session(client, shop, ref="D2")["session_id"]
    token = authorize(client, a, s1)
    ch = start(client, a, s2)  # a challenge issued while the account was still active
    db.execute(update(User).where(User.id == a["id"]).values(status="disabled"))
    db.commit()
    from tests.payment_helpers import b64
    from tests.synthetic_scenes import GOOD_TURN, sequence
    frames = [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN)]
    res = client.post(f"/payments/sessions/{s2}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=a["headers"])
    assert res.status_code == 200 and res.json()["reason"] == "ACCOUNT_DISABLED" and res.json()["authorization"] is None
    assert client.post(f"/payments/sessions/{s2}/authenticate/start", headers=a["headers"]).status_code == 403  # no new challenges
    assert confirm(client, a, s1, token).status_code == 403  # a ticket issued earlier is useless once disabled
    assert txn_count(db) == 0


def test_missing_model_means_no_authorization(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    ch = start(client, a, sid)  # the challenge was issued while the model still existed
    db.execute(text("UPDATE model_versions SET status = 'retired'"))
    db.commit()
    from app.ml import registry
    from tests.payment_helpers import b64
    from tests.synthetic_scenes import GOOD_TURN, sequence
    registry.invalidate()
    frames = [b64(f) for f in sequence(0, ch["challenge"], GOOD_TURN)]
    res = client.post(f"/payments/sessions/{sid}/authenticate", json={"challenge_id": ch["challenge_id"], "frames": frames}, headers=a["headers"]).json()
    assert res["reason"] in ("MODEL_NOT_FOUND", "MODEL_NOT_TRAINED", "INSUFFICIENT_IDENTITIES") and res["authorization"] is None
    assert res["session_status"] == "CREATED"
    assert res["attempts_remaining"] == svc.max_auth_failures()  # system problem, not the customer's fault
    # and a new payment check cannot even start: the customer is told why instead of being asked for frames
    again = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"])
    assert again.status_code == 409 and again.json()["detail"]["code"] == res["reason"]


def test_malformed_authentication_requests_are_422_and_change_nothing(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    ch = start(client, a, sid)
    bad = [
        {},
        {"challenge_id": ch["challenge_id"], "frames": []},
        {"challenge_id": ch["challenge_id"], "frames": ["!!notbase64!!"] * 6},
        {"challenge_id": "short", "frames": ["AAAAAAAAAAAAAAAAAAAA"] * 6},
        {"challenge_id": ch["challenge_id"], "frames": ["AAAAAAAAAAAAAAAAAAAA"] * 6, "authenticated": True},
    ]
    for body in bad:
        assert client.post(f"/payments/sessions/{sid}/authenticate", json=body, headers=a["headers"]).status_code == 422
    assert session_row(db, sid).failed_auth_attempts == 0 and auth_rows(db) == []


# ============================================================ atomicity and concurrency


def test_confirmation_is_atomic(client, trained, shop, db, monkeypatch):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)

    def boom():
        raise RuntimeError("simulated crash while writing the transaction")

    monkeypatch.setattr(svc, "new_transaction_id", boom)
    with pytest.raises(RuntimeError):
        confirm(client, a, sid, token)
    monkeypatch.undo()
    # Nothing half-done: no transaction, authorization still usable, session still waiting.
    assert txn_count(db) == 0 and auth_rows(db)[0].status == "ACTIVE" and session_row(db, sid).status == "AUTHENTICATED"
    assert confirm(client, a, sid, token).status_code == 200


def test_simultaneous_confirmations_create_exactly_one_transaction(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, a, sid)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: confirm(client, a, sid, token), range(6)))
    codes = sorted(r.status_code for r in results)
    assert codes.count(200) == 1 and all(c in (200, 403, 409) for c in codes), codes
    assert txn_count(db) == 1
    assert db.scalar(select(func.count()).select_from(PaymentAuthorization).where(PaymentAuthorization.status == "CONSUMED")) == 1


def test_database_itself_refuses_a_second_successful_transaction_per_session(db, client, trained, shop):
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    assert confirm(client, a, sid, authorize(client, a, sid)).status_code == 200
    ps = session_row(db, sid)
    from sqlalchemy.exc import IntegrityError
    db.add(Transaction(transaction_id="FP-DUPLICATE1", payer_id=a["id"], merchant_id=ps.merchant_id, payment_session_id=ps.id, amount=Decimal("1.00"), status="SUCCESS"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# ============================================================ isolation


def test_merchant_isolation(client, trained, shop):
    a, _ = trained
    other = new_merchant(client, "OtherShop")
    mine = create_session(client, shop, ref="MINE")
    theirs = create_session(client, other, ref="THEIRS")
    confirm(client, a, mine["session_id"], authorize(client, a, mine["session_id"]))
    paid = confirm(client, a, theirs["session_id"], authorize(client, a, theirs["session_id"])).json()

    assert client.get(f"/merchant/payment-sessions/{theirs['session_id']}", headers=shop["headers"]).status_code == 404
    assert client.post(f"/merchant/payment-sessions/{theirs['session_id']}/cancel", headers=shop["headers"]).status_code == 404
    assert [s["order_reference"] for s in client.get("/merchant/payment-sessions", headers=shop["headers"]).json()] == ["MINE"]
    assert [t["order_reference"] for t in client.get("/merchant/transactions", headers=shop["headers"]).json()] == ["MINE"]
    assert client.get(f"/merchant/transactions/{paid['transaction_id']}", headers=shop["headers"]).status_code == 404
    assert client.get(f"/merchant/payment-sessions/{theirs['session_id']}", headers=other["headers"]).json()["status"] == "PAID"
    sm = client.get("/merchant/summary", headers=shop["headers"]).json()
    assert sm["transactions"] == 1 and Decimal(sm["total_revenue"]) == Decimal("950.00")
    # the other merchant's session is still payable status-wise (not cancelled by the attempt above)
    assert client.get(f"/merchant/payment-sessions/{theirs['session_id']}", headers=other["headers"]).json()["status"] == "PAID"


def test_customer_isolation(client, trained, shop):
    a, b = trained
    sa, sb = create_session(client, shop, ref="FOR-A")["session_id"], create_session(client, shop, ref="FOR-B")["session_id"]
    ra = confirm(client, a, sa, authorize(client, a, sa, identity=0)).json()
    rb = confirm(client, b, sb, authorize(client, b, sb, identity=1)).json()
    assert [t["transaction_id"] for t in client.get("/payments/transactions", headers=a["headers"]).json()] == [ra["transaction_id"]]
    assert [t["transaction_id"] for t in client.get("/payments/transactions", headers=b["headers"]).json()] == [rb["transaction_id"]]
    assert client.get(f"/payments/transactions/{rb['transaction_id']}", headers=a["headers"]).status_code == 404
    assert client.get(f"/payments/transactions/{ra['transaction_id']}", headers=b["headers"]).status_code == 404
    assert client.get("/payments/transactions").status_code == 401
    assert client.get("/payments/transactions", headers=shop["headers"]).status_code == 403
    assert client.get(f"/payments/transactions/{ra['transaction_id']}", headers=shop["headers"]).status_code == 403


def test_history_paging_and_order(client, trained, shop):
    a, _ = trained
    for i in range(3):
        sid = create_session(client, shop, ref=f"P-{i}")["session_id"]
        confirm(client, a, sid, authorize(client, a, sid))
    refs = [t["order_reference"] for t in client.get("/payments/transactions", headers=a["headers"]).json()]
    assert refs == ["P-2", "P-1", "P-0"]
    assert [t["order_reference"] for t in client.get("/payments/transactions?limit=1&offset=1", headers=a["headers"]).json()] == ["P-1"]
    assert client.get("/payments/transactions?limit=0", headers=a["headers"]).status_code == 422
    assert client.get("/payments/transactions?limit=102", headers=a["headers"]).status_code == 422


def test_unknown_transaction_is_404(client, trained, shop):
    a, _ = trained
    assert client.get("/payments/transactions/FP-NOPE", headers=a["headers"]).status_code == 404
    assert client.get("/merchant/transactions/FP-NOPE", headers=shop["headers"]).status_code == 404


def test_rate_limit_on_payment_endpoints(client, trained, shop, monkeypatch):
    from app.api import payments as pay_api
    a, _ = trained
    sid = create_session(client, shop)["session_id"]
    monkeypatch.setattr(pay_api.payment_limiter, "enabled", True)
    monkeypatch.setattr(pay_api.payment_limiter, "max_requests", 3)
    pay_api.payment_limiter.reset()
    codes = [client.get(f"/payments/sessions/{sid}", headers=a["headers"]).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    pay_api.payment_limiter.reset()


def test_empty_merchant_summary(client, shop):
    sm = client.get("/merchant/summary", headers=shop["headers"]).json()
    assert (Decimal(sm["total_revenue"]), sm["transactions"], sm["successful_payments"], sm["failed_payments"]) == (0, 0, 0, 0)
    assert len(sm["revenue_by_day"]) == 14 and all(Decimal(d["revenue"]) == 0 for d in sm["revenue_by_day"])


def test_session_without_enrolled_face_cannot_authorize(client, shop):
    c = new_customer(client, "No Face")
    sid = create_session(client, shop)["session_id"]
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=c["headers"])
    assert r.status_code == 409 and r.json()["detail"]["code"] in ("ENROLLMENT_INSUFFICIENT", "MODEL_STALE")  # no frames are ever requested


def _count_queries(client, path, headers):
    """Number of SQL statements the request issues (the N+1 check compares this at different list sizes)."""
    from sqlalchemy import event

    from app.database.session import engine

    n = []

    def hook(*_a, **_k):
        n.append(1)

    event.listen(engine, "before_cursor_execute", hook)
    try:
        assert client.get(path, headers=headers).status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", hook)
    return len(n)


def test_list_endpoints_use_a_constant_number_of_queries(client, trained, shop):
    """No N+1: listing 1 transaction and listing 6 issue the same number of SQL statements."""
    a, _ = trained
    paths = [("/payments/transactions?limit=50", a["headers"]), ("/merchant/transactions?limit=50", shop["headers"]),
             ("/payments/summary", a["headers"]), ("/merchant/summary", shop["headers"])]

    def pay(i):
        sid = create_session(client, shop, ref=f"Q-{i}")["session_id"]
        confirm(client, a, sid, authorize(client, a, sid))

    pay(0)
    one = [_count_queries(client, p, h) for p, h in paths]
    for i in range(1, 6):
        pay(i)
    six = [_count_queries(client, p, h) for p, h in paths]
    assert one == six, (one, six)
    assert max(six) <= 10  # measured: 2, 2, 2 and 9 (the merchant summary runs several constant aggregate queries)
