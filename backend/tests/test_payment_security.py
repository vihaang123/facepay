"""Security regression tests: face recognition is not payment authorization.

A face match only earns a short-lived, single-use ticket bound to ONE payment (customer, session, merchant, amount,
currency, order, model version). Confirming it needs the customer to state what they were shown; higher-risk payments
also need a payment PIN. These tests try to use a ticket for anything other than the payment it was issued for.

Real PostgreSQL, synthetic face frames (see synthetic_scenes.py); everything after the camera is the real code path.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text, update

from app.api import faces as faces_api
from app.core.config import get_settings
from app.main import app
from app.models import AuthenticationLog, PaymentAuthorization, PaymentSession, SecurityEvent, Transaction, User
from tests.conftest import STRONG_PASSWORD
from tests.payment_helpers import authenticate, authorize, b64, confirm, create_session, enroll, new_customer, new_merchant, set_threshold, shown
from tests.synthetic_scenes import BackgroundBoxDetector, empty_scene, scene


@pytest.fixture(autouse=True)
def scene_detector():
    app.dependency_overrides[faces_api.get_detector] = lambda: BackgroundBoxDetector()
    yield
    app.dependency_overrides.pop(faces_api.get_detector, None)


@pytest.fixture
def trained(client, db):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll(client, a, 0)
    enroll(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    set_threshold(db, [a["id"], b["id"]], 1000.0)
    return a, b


@pytest.fixture
def shop(client):
    return new_merchant(client, "SuperGrocery")


@pytest.fixture
def settings():
    return get_settings()


def code(r):
    return r.json()["detail"]["code"]


def txn_count(db):
    db.expire_all()
    return db.scalar(select(func.count()).select_from(Transaction))


def auth_row(db, i=-1):
    db.expire_all()
    return list(db.scalars(select(PaymentAuthorization).order_by(PaymentAuthorization.id)))[i]


def events(db, user_id):
    db.expire_all()
    return [e.kind for e in db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == user_id).order_by(SecurityEvent.id))]


def add_failed_logs(db, user_id, n, reason="LIVENESS_FAILED", minutes_ago=1):
    for _ in range(n):
        db.add(AuthenticationLog(user_id=user_id, result="FAILED", failure_reason=reason, timestamp=datetime.now(UTC) - timedelta(minutes=minutes_ago)))
    db.commit()


# ============================================================ face recognition alone pays nothing


def test_a_successful_face_check_creates_no_transaction_and_needs_explicit_confirmation(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    r = authenticate(client, a, sid)
    assert r.json()["result"] == "AUTHENTICATED" and r.json()["session_status"] == "AUTHENTICATED"
    assert txn_count(db) == 0  # recognised, live, authorised ... and still not paid
    token = r.json()["authorization"]["authorization_token"]
    assert r.json()["authorization"]["step_up_required"] is False  # ₹1,499 is a low-risk payment
    # Confirmation must state what was shown. Leaving any of it out is refused outright.
    for missing in ("expected_amount", "expected_merchant", "expected_order_reference"):
        body = {"authorization_token": token, **shown(client, a, sid)}
        body.pop(missing)
        assert client.post(f"/payments/sessions/{sid}/confirm", json=body, headers=a["headers"]).status_code == 422
    assert txn_count(db) == 0
    assert confirm(client, a, sid, token).status_code == 200 and txn_count(db) == 1


def test_the_authorization_snapshot_records_exactly_what_was_authorised(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    authorize(client, a, sid)
    row = auth_row(db)
    ps = db.scalar(select(PaymentSession).where(PaymentSession.session_id == sid))
    assert (row.user_id, row.payment_session_id, row.merchant_id) == (a["id"], ps.id, shop["id"])
    assert row.amount == Decimal("1499.00") and row.currency == "INR" and row.order_reference == "ORD-10294"
    assert row.model_version and row.authentication_log_id and (row.expires_at - row.created_at).total_seconds() <= 180
    assert len(row.token_hash) == 64  # only a hash of the bearer token is stored, and nothing biometric


# ============================================================ binding: a ticket works for ONE payment only


def test_a_ticket_for_customer_a_merchant_a_1499_cannot_be_used_by_customer_b(client, trained, shop, db):
    a, b = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    r = confirm(client, b, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txn_count(db) == 0
    assert confirm(client, a, sid, token).status_code == 200  # the rightful owner can still use it


def test_a_ticket_cannot_pay_another_merchants_session_a_bigger_amount_or_another_order(client, trained, shop, db):
    a, _ = trained
    other_shop = new_merchant(client, "Other Mart")
    s1 = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    s_other_merchant = create_session(client, other_shop, amount="1499", ref="ORD-10294")["session_id"]
    s_bigger = create_session(client, shop, amount="5000", ref="ORD-10295")["session_id"]
    s_other_order = create_session(client, shop, amount="1499", ref="ORD-99999")["session_id"]
    token = authorize(client, a, s1)
    for other in (s_other_merchant, s_bigger, s_other_order):
        r = confirm(client, a, other, token)
        assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID", other
    assert txn_count(db) == 0
    assert confirm(client, a, s1, token).status_code == 200 and txn_count(db) == 1


@pytest.mark.parametrize(
    "field,wrong,expected_code",
    [
        ("expected_amount", "5000.00", "AMOUNT_MISMATCH"),
        ("expected_merchant", "Other Mart", "MERCHANT_MISMATCH"),
        ("expected_order_reference", "ORD-99999", "ORDER_MISMATCH"),
    ],
)
def test_confirming_with_details_other_than_the_ones_shown_is_refused(client, trained, shop, db, field, wrong, expected_code):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    r = confirm(client, a, sid, token, **{field: wrong})
    assert r.status_code == 409 and code(r) == expected_code
    assert txn_count(db) == 0 and auth_row(db).status == "ACTIVE"  # a mismatch does not burn the ticket
    assert confirm(client, a, sid, token).status_code == 200


@pytest.mark.parametrize(
    "tamper",
    [
        "UPDATE payment_sessions SET amount = 5000",
        "UPDATE payment_sessions SET order_reference = 'ORD-TAMPERED'",
        "UPDATE payment_sessions SET currency = 'USD'",
        "UPDATE payment_sessions SET merchant_id = (SELECT id FROM merchants WHERE business_name = 'Other Mart')",
        "UPDATE payment_authorizations SET amount = NULL",  # an authorization with no snapshot (older than this feature)
        "UPDATE payment_authorizations SET model_version = 'some-older-model'",
    ],
)
def test_any_change_to_the_payment_after_authorization_voids_the_ticket(client, trained, shop, db, tamper):
    a, _ = trained
    new_merchant(client, "Other Mart")
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    db.execute(text(tamper))
    db.commit()
    r = confirm(client, a, sid, token)  # the helper confirms whatever the session now shows
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID", r.text
    assert txn_count(db) == 0
    assert auth_row(db).status == "REVOKED"


def test_retraining_the_model_after_authentication_voids_the_ticket(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200  # new model version
    r = confirm(client, a, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID" and txn_count(db) == 0


# ============================================================ expiry, single use, replay


def test_an_expired_ticket_is_rejected(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    db.execute(update(PaymentAuthorization).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    r = confirm(client, a, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_EXPIRED" and txn_count(db) == 0


def test_a_ticket_cannot_be_replayed_after_it_was_used(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    assert confirm(client, a, sid, token).status_code == 200
    again = confirm(client, a, sid, token)
    assert again.status_code in (403, 409) and code(again) in ("SESSION_ALREADY_PAID", "AUTHORIZATION_USED")
    assert txn_count(db) == 1  # no duplicate transaction
    # nor can it be carried over to a fresh session for the same order
    s2 = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    r = confirm(client, a, s2, token)
    assert r.status_code == 403 and txn_count(db) == 1


def test_a_new_authentication_revokes_the_earlier_ticket(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    old = authorize(client, a, sid)
    new = authorize(client, a, sid)
    assert confirm(client, a, sid, old).status_code == 403
    assert confirm(client, a, sid, new).status_code == 200 and txn_count(db) == 1


# ============================================================ limits (settings, enforced by the backend)


def test_a_payment_above_the_per_transaction_limit_cannot_be_created(client, shop, settings, monkeypatch):
    monkeypatch.setattr(settings, "per_transaction_limit", Decimal("2000"))
    r = client.post("/merchant/payment-sessions", json={"amount": "2000.01", "order_reference": "BIG-1"}, headers=shop["headers"])
    assert r.status_code == 422 and code(r) == "PER_TRANSACTION_LIMIT"
    assert client.post("/merchant/payment-sessions", json={"amount": "2000", "order_reference": "OK-1"}, headers=shop["headers"]).status_code == 201


def test_the_limit_is_enforced_again_when_authenticating_and_confirming(client, trained, shop, db, settings, monkeypatch):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    monkeypatch.setattr(settings, "per_transaction_limit", Decimal("1000"))  # lowered after the ticket was issued
    r = confirm(client, a, sid, token)
    assert r.status_code == 409 and code(r) == "PER_TRANSACTION_LIMIT" and txn_count(db) == 0
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"])
    assert r.status_code == 409 and code(r) == "PER_TRANSACTION_LIMIT"


def test_the_daily_limit_counts_successful_payments_in_the_last_24_hours(client, trained, shop, db, settings, monkeypatch):
    a, _ = trained
    monkeypatch.setattr(settings, "daily_payment_limit", Decimal("3000"))
    s1 = create_session(client, shop, amount="2000", ref="D-1")["session_id"]
    assert confirm(client, a, s1, authorize(client, a, s1)).status_code == 200
    s2 = create_session(client, shop, amount="1500", ref="D-2")["session_id"]  # 2000 + 1500 > 3000
    r = client.post(f"/payments/sessions/{s2}/authenticate/start", headers=a["headers"])
    assert r.status_code == 409 and code(r) == "DAILY_LIMIT_EXCEEDED"
    assert "DAILY_LIMIT_HIT" in events(db, a["id"])
    s3 = create_session(client, shop, amount="1000", ref="D-3")["session_id"]
    assert confirm(client, a, s3, authorize(client, a, s3)).status_code == 200  # exactly at the limit is fine
    # payments older than 24 hours no longer count
    db.execute(update(Transaction).values(timestamp=datetime.now(UTC) - timedelta(hours=25)))
    db.commit()
    s4 = create_session(client, shop, amount="1500", ref="D-4")["session_id"]
    assert client.post(f"/payments/sessions/{s4}/authenticate/start", headers=a["headers"]).status_code == 200


# ============================================================ risk-based step-up (prototype) and the payment PIN


def set_pin(client, user, pin="482915", password=STRONG_PASSWORD):
    return client.put("/security/pin", json={"password": password, "new_pin": pin}, headers=user["headers"])


def test_low_risk_payments_need_no_pin(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    r = authenticate(client, a, sid).json()["authorization"]
    assert r["step_up_required"] is False and r["step_up_reasons"] == []
    assert confirm(client, a, sid, r["authorization_token"]).status_code == 200


def test_a_large_amount_requires_the_pin_and_says_why(client, trained, shop, db, settings, monkeypatch):
    a, _ = trained
    monkeypatch.setattr(settings, "step_up_amount_threshold", Decimal("1000"))
    monkeypatch.setattr(settings, "step_up_pin_change_minutes", 0)
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    auth = authenticate(client, a, sid).json()["authorization"]
    assert auth["step_up_required"] is True and auth["pin_set"] is False and auth["step_up_reasons"] == ["a larger amount than usual"]
    # no PIN has been set: the payment cannot complete, and the ticket survives so they can set one and retry
    r = confirm(client, a, sid, auth["authorization_token"])
    assert r.status_code == 403 and code(r) == "PIN_NOT_SET" and txn_count(db) == 0
    assert set_pin(client, a).status_code == 200
    sid2 = create_session(client, shop, amount="1499", ref="ORD-10296")["session_id"]
    token = authorize(client, a, sid2)
    assert code(confirm(client, a, sid2, token)) == "PIN_REQUIRED"  # not a guess, not counted
    wrong = confirm(client, a, sid2, token, pin="000000")
    assert wrong.status_code == 403 and code(wrong) == "PIN_INCORRECT" and txn_count(db) == 0
    assert auth_row(db).status == "ACTIVE"
    ok = confirm(client, a, sid2, token, pin="482915")
    assert ok.status_code == 200 and ok.json()["authentication"] == "Face + basic liveness check + payment PIN"
    assert auth_row(db).step_up_verified_at is not None and txn_count(db) == 1


def test_the_pin_locks_after_repeated_wrong_attempts(client, trained, shop, db, settings, monkeypatch):
    a, _ = trained
    monkeypatch.setattr(settings, "step_up_amount_threshold", Decimal("1000"))
    monkeypatch.setattr(settings, "step_up_pin_change_minutes", 0)
    assert set_pin(client, a).status_code == 200
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    for _ in range(settings.pin_max_attempts):
        assert code(confirm(client, a, sid, token, pin="111111")) == "PIN_INCORRECT"
    locked = confirm(client, a, sid, token, pin="482915")  # even the right PIN is refused while locked
    assert locked.status_code == 429 and code(locked) == "PIN_LOCKED" and "Retry-After" in locked.headers
    assert txn_count(db) == 0
    assert events(db, a["id"]).count("PIN_FAILED") == settings.pin_max_attempts and "PIN_LOCKED" in events(db, a["id"])
    db.execute(update(User).where(User.id == a["id"]).values(pin_locked_until=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    assert confirm(client, a, sid, token, pin="482915").status_code == 200


def test_recent_rejected_face_checks_require_the_pin(client, trained, shop, db):
    a, _ = trained
    add_failed_logs(db, a["id"], 2)  # two rejected checks a minute ago
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    auth = authenticate(client, a, sid).json()["authorization"]
    assert auth["step_up_required"] is True and "recent unsuccessful face checks" in auth["step_up_reasons"]


def test_camera_problems_do_not_trigger_step_up(client, trained, shop, db):
    a, _ = trained
    add_failed_logs(db, a["id"], 5, reason="FACE_NOT_DETECTED", minutes_ago=10)  # inside the 15-minute failure window
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    assert authenticate(client, a, sid).json()["authorization"]["step_up_required"] is False


def test_many_attempts_in_a_short_time_require_the_pin_even_if_they_were_camera_problems(client, trained, shop, db):
    a, _ = trained
    add_failed_logs(db, a["id"], 5, reason="FACE_NOT_DETECTED", minutes_ago=0)  # 5 + this attempt = 6 within two minutes
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    auth = authenticate(client, a, sid).json()["authorization"]
    assert auth["step_up_required"] is True and auth["step_up_reasons"] == ["many attempts in a short time"]


def test_pin_rules(client, trained, db):
    a, _ = trained
    assert set_pin(client, a, password="wrong-Password-1").status_code == 403
    for bad in ("12345", "1234567", "12345a", "١٢٣٤٥٦", ""):
        assert set_pin(client, a, pin=bad).status_code in (403, 422), bad
    assert code(set_pin(client, a, pin="12345")) == "PIN_INVALID"
    ok = set_pin(client, a)
    assert ok.status_code == 200 and ok.json()["pin_set"] is True
    assert "482915" not in ok.text
    db.expire_all()
    stored = db.scalar(select(User.payment_pin_hash).where(User.id == a["id"]))
    assert stored.startswith("$argon2") and "482915" not in stored
    removed = client.post("/security/pin/remove", json={"password": STRONG_PASSWORD}, headers=a["headers"])
    assert removed.status_code == 200 and removed.json()["pin_set"] is False
    assert events(db, a["id"]) == ["PIN_SET", "PIN_REMOVED"]


# ============================================================ lockout after repeated biometric failures


def test_repeated_rejected_attempts_lock_biometrics_for_the_account(client, trained, shop, db, settings):
    a, b = trained
    add_failed_logs(db, a["id"], settings.biometric_lockout_failures)
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"])
    assert r.status_code == 429 and code(r) == "BIOMETRIC_LOCKED"
    assert r.json()["detail"]["message"] == "Too many unsuccessful attempts. Please try again later or use another verification method."
    assert int(r.headers["Retry-After"]) > 0
    assert client.post("/face-auth/challenge", headers=a["headers"]).status_code == 429  # the standalone check too
    # the lock is per account: another customer is unaffected
    assert client.post(f"/payments/sessions/{sid}/authenticate/start", headers=b["headers"]).status_code == 200
    # it lifts once the failures age out of the window
    db.execute(update(AuthenticationLog).values(timestamp=datetime.now(UTC) - timedelta(minutes=settings.biometric_lockout_window_minutes + 1)))
    db.commit()
    assert client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"]).status_code == 200


def test_a_rejection_never_says_whose_face_it_was(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    r = authenticate(client, a, sid, identity=1)  # Asha's account, Ravi's face
    body = r.json()
    assert body["result"] == "REJECTED" and body["reason"] == "IDENTITY_MISMATCH" and body["authorization"] is None
    assert "Ravi" not in r.text and body["identity"]["name"] is None  # nothing about whose face it was
    assert txn_count(db) == 0


def test_camera_problems_never_lock_the_account(client, trained, db, settings):
    a, _ = trained
    add_failed_logs(db, a["id"], settings.biometric_lockout_failures * 2, reason="FACE_NOT_DETECTED")
    assert client.post("/face-auth/challenge", headers=a["headers"]).status_code == 200


# ============================================================ customer security controls


def test_turning_biometric_payments_off_blocks_face_authentication_and_unused_tickets(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    off = client.put("/security/biometric", json={"enabled": False}, headers=a["headers"])
    assert off.status_code == 200 and off.json()["biometric_enabled"] is False
    for path in (f"/payments/sessions/{sid}/authenticate/start", "/face-auth/challenge"):
        r = client.post(path, headers=a["headers"])
        assert r.status_code == 403 and code(r) == "BIOMETRIC_DISABLED", path
    r = confirm(client, a, sid, token)  # a ticket issued before the switch is no longer honoured
    assert r.status_code == 403 and code(r) == "BIOMETRIC_DISABLED" and txn_count(db) == 0
    on = client.put("/security/biometric", json={"enabled": True}, headers=a["headers"])
    assert on.json()["biometric_enabled"] is True
    assert confirm(client, a, sid, token).status_code == 200
    assert events(db, a["id"])[:2] == ["BIOMETRIC_DISABLED", "BIOMETRIC_ENABLED"]


def test_removing_face_data_retires_the_profile_and_is_audited(client, trained, shop, db):
    a, _ = trained
    assert client.get("/security/overview", headers=a["headers"]).json()["face_enrolled"] is True
    assert client.delete("/faces/samples", headers=a["headers"]).status_code == 204
    ov = client.get("/security/overview", headers=a["headers"]).json()
    assert ov["face_enrolled"] is False and ov["samples_stored"] == 0
    assert "FACE_DATA_REMOVED" in events(db, a["id"])
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=a["headers"])
    # Removing a trained customer's data retires the shared model, so no check can start for them or anyone else.
    assert r.status_code == 409 and r.json()["detail"]["code"] in ("ENROLLMENT_INSUFFICIENT", "INSUFFICIENT_IDENTITIES")


def test_the_overview_shows_attempts_transactions_limits_and_never_biometric_data(client, trained, shop, db):
    a, _ = trained
    add_failed_logs(db, a["id"], 1, reason="IDENTITY_MISMATCH")
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    token = authorize(client, a, sid)
    receipt = confirm(client, a, sid, token).json()
    ov = client.get("/security/overview", headers=a["headers"])
    assert ov.status_code == 200
    body = ov.json()
    assert body["biometric_enabled"] and body["face_enrolled"] and body["last_successful_authentication"]
    assert body["risk_label"] == "Risk-based authorization prototype"
    assert body["recent_transactions"][0]["transaction_id"] == receipt["transaction_id"]
    assert body["recent_transactions"][0]["merchant_name"] == "SuperGrocery"
    ok = next(x for x in body["recent_attempts"] if x["result"] == "SUCCESS")
    assert ok["payment_session_ref"] == sid and ok["transaction_ref"] == receipt["transaction_id"]
    bad = next(x for x in body["recent_attempts"] if x["result"] == "FAILED")
    assert bad["category"] == "Face not recognised"
    assert Decimal(body["limits"]["per_transaction"]) > 0 and Decimal(body["limits"]["spent_last_24h"]) == Decimal("1499.00")
    for forbidden in ("image", "crop", "vector", "centroid", "feature", "token", "pin_hash", "password"):
        assert forbidden not in ov.text.lower(), forbidden


def test_security_routes_need_a_customer_login(client, shop, trained):
    a, _ = trained
    for method, path in (("get", "/security/overview"), ("put", "/security/biometric"), ("put", "/security/pin")):
        assert getattr(client, method)(path).status_code == 401
        assert getattr(client, method)(path, headers=shop["headers"]).status_code == 403  # a merchant token is not a customer


# ============================================================ audit trail


def test_every_attempt_is_logged_with_a_reason_category_and_references_but_no_images(client, trained, shop, db):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    authenticate(client, a, sid, identity=1)  # rejected
    token = authorize(client, a, sid)
    txn = confirm(client, a, sid, token).json()["transaction_id"]
    db.expire_all()
    rows = list(db.scalars(select(AuthenticationLog).where(AuthenticationLog.user_id == a["id"]).order_by(AuthenticationLog.id)))
    assert [r.result for r in rows] == ["FAILED", "SUCCESS"]
    assert rows[0].failure_reason == "IDENTITY_MISMATCH" and rows[0].payment_session_ref == sid and rows[0].transaction_ref is None
    assert rows[1].payment_session_ref == sid and rows[1].transaction_ref == txn
    listed = client.get("/face-auth/attempts", headers=a["headers"])
    assert listed.status_code == 200 and listed.json()[0]["transaction_ref"] == txn
    assert "PAYMENT_CONFIRMED" in events(db, a["id"])
    columns = {c.name for c in AuthenticationLog.__table__.columns}
    assert not {c for c in columns if any(k in c for k in ("image", "frame", "crop", "vector", "photo"))}


def test_the_receipt_says_how_the_payer_was_verified(client, trained, shop):
    a, _ = trained
    sid = create_session(client, shop, amount="1499", ref="ORD-10294")["session_id"]
    receipt = confirm(client, a, sid, authorize(client, a, sid)).json()
    assert receipt["authentication"] == "Face + basic liveness check"
    again = client.get(f"/payments/transactions/{receipt['transaction_id']}", headers=a["headers"]).json()
    assert again["authentication"] == "Face + basic liveness check"


# ============================================================ guided enrolment: the server decides


def sample(client, user, identity, variation, pose="neutral", **kw):
    return client.post("/faces/samples", json={"image_base64": b64(scene(identity, variation, **kw)), "pose": pose}, headers=user["headers"])


def test_each_accepted_sample_reports_progress_and_the_next_pose(client):
    u = new_customer(client)
    r = sample(client, u, 0, 1, "neutral")
    assert r.status_code == 201
    body = r.json()
    assert body["accepted"] is True and body["next_pose"] == "neutral" and body["progress"] == {"captured": 1, "required": 15}
    for v in (2, 3):
        body = sample(client, u, 0, v, "neutral").json()
    assert body["next_pose"] == "turn_left" and body["progress"]["captured"] == 3
    g = body["enrollment"]["guided"]
    assert [p["pose"] for p in g["sequence"]] == ["neutral", "turn_left", "turn_right", "chin_up", "chin_down"] and g["complete"] is False
    assert "centroid" not in r.text and "vector" not in r.text and "image" not in r.text.replace("image_base64", "")


def test_guided_enrolment_completes_and_resumes_from_server_state(client):
    u = new_customer(client)
    poses = ["neutral", "turn_left", "turn_right", "chin_up", "chin_down"]
    v = 0
    for pose in poses:
        for _ in range(3):
            v += 1
            assert sample(client, u, 0, v, pose).status_code == 201
    status = client.get("/faces/enrollment", headers=u["headers"]).json()
    assert status["guided"]["complete"] is True and status["guided"]["next_pose"] is None and status["guided"]["captured"] == 15
    assert status["eligible"] is True


def test_an_identical_frame_is_refused_as_a_duplicate(client):
    u = new_customer(client)
    assert sample(client, u, 0, 1, "neutral").status_code == 201
    r = sample(client, u, 0, 1, "turn_left")  # the very same frame sent again, even under another pose
    assert r.status_code == 409 and code(r) == "DUPLICATE_SAMPLE"
    assert client.get("/faces/enrollment", headers=u["headers"]).json()["total_samples"] == 1


def test_duplicates_are_only_checked_against_your_own_samples(client):
    a, b = new_customer(client), new_customer(client)
    assert sample(client, a, 0, 1).status_code == 201
    assert sample(client, b, 0, 1).status_code == 201


def test_the_server_rejects_bad_frames_whatever_the_client_thinks(client):
    u = new_customer(client)
    two_faces = scene(0, 1, extra=[(1, 2, 20, 70, 96)])
    r = client.post("/faces/samples", json={"image_base64": b64(two_faces), "pose": "neutral"}, headers=u["headers"])
    assert r.status_code == 422 and code(r) == "MULTIPLE_FACES"
    r = client.post("/faces/samples", json={"image_base64": b64(empty_scene()), "pose": "neutral"}, headers=u["headers"])
    assert r.status_code == 422 and code(r) == "NO_FACE"
    from tests.synthetic_scenes import blurry_scene

    r = client.post("/faces/samples", json={"image_base64": b64(blurry_scene(0, 1)), "pose": "neutral"}, headers=u["headers"])
    assert r.status_code == 422 and code(r) in ("TOO_BLURRY", "NO_FACE")
    r = client.post("/faces/samples", json={"image_base64": b64(scene(0, 1)), "pose": "neutral", "accepted": True, "quality": {"ok": True}}, headers=u["headers"])
    assert r.status_code == 201  # extra client claims are simply ignored; they decide nothing
    assert client.get("/faces/enrollment", headers=u["headers"]).json()["total_samples"] == 1


def test_enrolment_needs_a_customer_login(client, shop):
    body = {"image_base64": b64(scene(0, 1)), "pose": "neutral"}
    assert client.post("/faces/samples", json=body).status_code == 401
    assert client.post("/faces/samples", json=body, headers=shop["headers"]).status_code == 403
    assert client.post("/faces/assess", json={"image_base64": b64(scene(0, 1))}).status_code == 401


def test_the_live_check_describes_the_frame_and_stores_nothing(client):
    u = new_customer(client)
    ok = client.post("/faces/assess", json={"image_base64": b64(scene(0, 1))}, headers=u["headers"])
    assert ok.status_code == 200
    body = ok.json()
    assert body["state"] == "OK" and body["faces"] == 1
    face = body["face"]
    assert set(face) == {"cx", "cy", "width", "height"} and all(0 <= v <= 1 for v in face.values())
    none = client.post("/faces/assess", json={"image_base64": b64(empty_scene())}, headers=u["headers"]).json()
    assert none["state"] == "NO_FACE" and none["faces"] == 0 and none["face"] is None
    two = client.post("/faces/assess", json={"image_base64": b64(scene(0, 1, extra=[(1, 2, 20, 70, 96)]))}, headers=u["headers"]).json()
    assert two["state"] == "MULTIPLE_FACES" and two["faces"] == 2
    assert client.get("/faces/enrollment", headers=u["headers"]).json()["total_samples"] == 0  # nothing was stored


def test_enrolment_uploads_are_rate_limited_per_customer(client, monkeypatch):
    limiter = faces_api.enroll_limiter
    monkeypatch.setattr(limiter, "enabled", True)
    monkeypatch.setattr(limiter, "max_requests", 3)
    limiter.reset()
    u, other = new_customer(client), new_customer(client)
    codes = [sample(client, u, 0, v, "neutral").status_code for v in range(1, 6)]
    assert codes[:3] == [201, 201, 201] and codes[3:] == [429, 429]
    assert sample(client, other, 1, 1, "neutral").status_code == 201  # per customer, not global
    limiter.reset()
