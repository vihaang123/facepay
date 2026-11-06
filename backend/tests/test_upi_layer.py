"""The UPI-style layer: a 12-digit reference, the step trail and the simulated bank behaviours.

Everything is simulated; these tests pin down that a simulated bank failure can only ever turn a would-be success into a recorded
failure, that it never moves money or pays a session, and that nothing leaks to the wrong party."""

import re

import pytest
from sqlalchemy import func, select

from app.core import upi
from app.models import BankConnection, PaymentAuthorization, PaymentSession, SecurityEvent, Transaction
from tests.payment_helpers import authorize, confirm, create_session, enroll, new_customer, new_merchant, set_threshold
from tests.transfer_helpers import prepared


pytestmark = pytest.mark.usefixtures("scene_detector")  # synthetic camera frames (fixture shared via transfer_helpers)


@pytest.fixture
def asha(client, db):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")  # training needs at least two enrolled people
    enroll(client, a, 0)
    enroll(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    set_threshold(db, [a["id"], b["id"]], 1000.0)
    return a


@pytest.fixture
def shop(client):
    return new_merchant(client, "SuperGrocery")


def behave(client, cust, mode, connection_id=None):
    cid = connection_id or cust["bank"]["connection_id"]
    return client.patch(f"/banks/{cid}/behavior", json={"behavior": mode}, headers=cust["headers"])


def txns(db):
    db.expire_all()
    return list(db.scalars(select(Transaction).order_by(Transaction.id)))


def pay(client, cust, sid):
    return confirm(client, cust, sid, authorize(client, cust, sid))


# ------------------------------------------------------------------ the reference number


def test_utr_helper_makes_twelve_digits_never_starting_with_zero():
    values = {upi.new_utr() for _ in range(500)}
    assert all(re.fullmatch(r"[1-9][0-9]{11}", v) for v in values)
    assert len(values) == 500  # random, not a counter


def test_a_successful_payment_gets_a_unique_utr_and_a_five_step_trail(client, asha, shop, db):
    rec = pay(client, asha, create_session(client, shop)["session_id"]).json()
    assert re.fullmatch(r"[1-9][0-9]{11}", rec["utr"]) and rec["failure_code"] is None and rec["failure_message"] is None
    assert [s["key"] for s in rec["trail"]] == ["face", "confirm", "debit", "credit", "complete"]
    assert {s["state"] for s in rec["trail"]} == {"done"}
    assert "HDFC Bank" in rec["trail"][2]["label"] and "(simulated)" in rec["trail"][2]["label"]
    (t,) = txns(db)
    assert t.utr == rec["utr"]
    second = pay(client, asha, create_session(client, shop, ref="SG-2")["session_id"]).json()
    assert second["utr"] != rec["utr"]


def test_the_merchant_trail_never_names_the_payers_bank(client, asha, shop):
    rec = pay(client, asha, create_session(client, shop)["session_id"]).json()
    seen = client.get(f"/merchant/transactions/{rec['transaction_id']}", headers=shop["headers"]).json()
    assert seen["utr"] == rec["utr"]
    assert all("HDFC" not in s["label"] for s in seen["trail"]) and "Payer's bank" in seen["trail"][2]["label"]
    assert seen["funding_source"] is None


def test_activity_detail_carries_the_reference_and_trail(client, asha, shop):
    rec = pay(client, asha, create_session(client, shop)["session_id"]).json()
    d = client.get(f"/activity/{rec['transaction_id']}", headers=asha["headers"]).json()
    assert d["utr"] == rec["utr"] and d["trail"] == rec["trail"] and d["failure_message"] is None


# ------------------------------------------------------------------ the demo behaviour switch


def test_a_new_account_works_normally_and_the_catalog_lists_the_behaviours(client, asha):
    assert asha["bank"]["sim_behavior"] == "NORMAL" and asha["bank"]["sim_behavior_label"] == "Works normally"
    cat = client.get("/banks/catalog", headers=asha["headers"]).json()
    assert [b["code"] for b in cat["behaviors"]] == ["NORMAL", "DECLINE", "TIMEOUT"] and "Demo" in cat["behavior_note"]


def test_the_owner_can_change_the_behaviour_and_it_is_audited(client, asha, db):
    r = behave(client, asha, "DECLINE")
    assert r.status_code == 200 and r.json()["sim_behavior"] == "DECLINE" and r.json()["sim_behavior_label"] == "Declines payments"
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(SecurityEvent).where(SecurityEvent.kind == "BANK_BEHAVIOR_CHANGED")) == 1


@pytest.mark.parametrize("bad", ["", "FAIL", "normal", "DECLINE ", "x" * 13])
def test_an_unknown_behaviour_is_refused(client, asha, bad):
    assert behave(client, asha, bad).status_code in (422,)
    assert client.get("/banks", headers=asha["headers"]).json()[0]["sim_behavior"] == "NORMAL"


def test_extra_fields_are_refused_and_another_customers_account_is_invisible(client, asha):
    other = new_customer(client, "Other Person")
    assert client.patch(f"/banks/{asha['bank']['connection_id']}/behavior", json={"behavior": "DECLINE", "x": 1}, headers=asha["headers"]).status_code == 422
    r = behave(client, other, "DECLINE", connection_id=asha["bank"]["connection_id"])
    assert r.status_code == 404
    assert client.get("/banks", headers=asha["headers"]).json()[0]["sim_behavior"] == "NORMAL"


def test_a_merchant_cannot_use_the_switch(client, shop, asha):
    r = client.patch(f"/banks/{asha['bank']['connection_id']}/behavior", json={"behavior": "DECLINE"}, headers=shop["headers"])
    assert r.status_code in (401, 403)


# ------------------------------------------------------------------ a simulated bank failure


@pytest.mark.parametrize("mode,code,words", [("DECLINE", "BANK_DECLINED", "declined"), ("TIMEOUT", "BANK_TIMEOUT", "did not respond")])
def test_a_bank_failure_records_a_failed_transaction_and_moves_nothing(client, asha, shop, db, mode, code, words):
    assert behave(client, asha, mode).status_code == 200
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, asha, sid)
    r = confirm(client, asha, sid, token)
    assert r.status_code == 409
    d = r.json()["detail"]
    assert d["code"] == code and words in d["message"] and "No money moved" in d["message"]
    assert re.fullmatch(r"FP-[0-9A-HJKMNP-TV-Z]{10}", d["transaction_id"]) and re.fullmatch(r"[1-9][0-9]{11}", d["utr"])

    (t,) = txns(db)
    assert (t.status, t.failure_code, t.utr, t.transaction_id) == ("FAILED", code, d["utr"], d["transaction_id"])
    ps = db.scalar(select(PaymentSession).where(PaymentSession.session_id == sid))
    assert ps.status == "CREATED"  # payable again, NOT paid
    auth = db.scalar(select(PaymentAuthorization).where(PaymentAuthorization.payment_session_id == ps.id))
    assert auth.status == "REVOKED" and auth.consumed_at is None
    # nothing counts as revenue or as paid
    summary = client.get("/merchant/summary", headers=shop["headers"]).json()
    assert float(summary["total_revenue"]) == 0 and summary["successful_payments"] == 0 and summary["failed_payments"] == 1
    assert client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()["paid_at"] is None
    rec = client.get("/merchant/reconciliation", headers=shop["headers"]).json()
    assert float(rec["paid_total"]) == 0 and rec["mismatches"] == 0
    assert db.scalar(select(func.count()).select_from(SecurityEvent).where(SecurityEvent.kind == "PAYMENT_BANK_FAILED")) == 1


def test_the_failed_receipt_explains_what_happened_and_the_trail_stops_at_the_bank(client, asha, shop):
    behave(client, asha, "DECLINE")
    sid = create_session(client, shop)["session_id"]
    tid = confirm(client, asha, sid, authorize(client, asha, sid)).json()["detail"]["transaction_id"]
    rec = client.get(f"/payments/transactions/{tid}", headers=asha["headers"]).json()
    assert rec["status"] == "FAILED" and rec["failure_code"] == "BANK_DECLINED" and "declined" in rec["failure_message"]
    assert [s["state"] for s in rec["trail"]] == ["done", "done", "failed", "skipped", "skipped"]
    assert "HDFC Bank" in rec["trail"][2]["label"] and "declined" in rec["trail"][2]["label"]
    assert rec["trail"][4]["label"] == "No money moved"
    d = client.get(f"/activity/{tid}", headers=asha["headers"]).json()
    assert d["status"] == "FAILED" and d["failure_message"] == rec["failure_message"] and d["trail"] == rec["trail"]


def test_a_failed_attempt_cannot_be_replayed_and_a_fresh_face_check_then_a_working_bank_pays(client, asha, shop, db):
    behave(client, asha, "DECLINE")
    sid = create_session(client, shop)["session_id"]
    token = authorize(client, asha, sid)
    assert confirm(client, asha, sid, token).status_code == 409
    # the same ticket is dead even though the bank now works
    behave(client, asha, "NORMAL")
    again = confirm(client, asha, sid, token)
    assert again.status_code == 403 and again.json()["detail"]["code"] == "AUTHORIZATION_INVALID"
    assert [t.status for t in txns(db)] == ["FAILED"]
    # verify the face again, and it goes through exactly once
    ok = confirm(client, asha, sid, authorize(client, asha, sid))
    assert ok.status_code == 200 and ok.json()["status"] == "SUCCESS"
    assert [t.status for t in txns(db)] == ["FAILED", "SUCCESS"]
    assert len({t.utr for t in txns(db)}) == 2
    # paid once only: the paid session refuses even to start another face check
    again_start = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=asha["headers"])
    assert again_start.status_code == 409 and again_start.json()["detail"]["code"] == "SESSION_ALREADY_PAID"
    assert [t.status for t in txns(db)] == ["FAILED", "SUCCESS"]


def test_choosing_another_bank_after_a_decline_works(client, asha, shop, db):
    other = client.post("/banks", json={"bank_code": "sbi", "account_type": "SAVINGS"}, headers=asha["headers"]).json()
    behave(client, asha, "DECLINE")  # the default HDFC account declines
    sid = create_session(client, shop)["session_id"]
    assert confirm(client, asha, sid, authorize(client, asha, sid)).status_code == 409
    ok = confirm(client, asha, sid, authorize(client, asha, sid), funding_source_id=other["connection_id"])
    assert ok.status_code == 200 and ok.json()["funding_source"]["bank_name"] == "State Bank of India"


def test_a_money_request_stays_pending_after_a_bank_failure(client, world, db):
    asha, ravi, _ = world  # Ravi asks Asha for money; Asha's bank times out when she tries to pay
    ref = client.post(
        "/requests",
        json={"payer_facepay_id": asha["facepay_id"], "amount": "120.00", "purpose": "BILL_SPLIT", "note": "Dinner split"},
        headers=ravi["headers"],
    ).json()["request_id"]
    behave(client, asha, "TIMEOUT")
    sid = client.post(f"/requests/{ref}/pay", headers=asha["headers"]).json()["session_id"]
    r = confirm(client, asha, sid, authorize(client, asha, sid, identity=0))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "BANK_TIMEOUT"
    got = client.get(f"/requests/{ref}", headers=asha["headers"]).json()
    assert got["status"] == "PENDING" and got["transaction_id"] is None and got["payable"] is True
    # a working bank and a fresh face check then settle it
    behave(client, asha, "NORMAL")
    ok = confirm(client, asha, sid, authorize(client, asha, sid, identity=0))
    assert ok.status_code == 200
    assert client.get(f"/requests/{ref}", headers=asha["headers"]).json()["status"] == "PAID"


def test_a_recipient_never_sees_a_payers_failed_attempt(client, world, db):
    asha, ravi, _ = world
    behave(client, asha, "DECLINE")
    sid = prepared(client, asha, ravi)
    tid = confirm(client, asha, sid, authorize(client, asha, sid, identity=0)).json()["detail"]["transaction_id"]
    assert client.get(f"/activity/{tid}", headers=asha["headers"]).status_code == 200
    assert client.get(f"/activity/{tid}", headers=ravi["headers"]).status_code == 404
    assert client.get(f"/payments/transactions/{tid}", headers=ravi["headers"]).status_code == 404
    assert all(i["ref"] != tid for i in client.get("/activity", headers=ravi["headers"]).json())
    assert any(i["ref"] == tid and i["status"] == "FAILED" for i in client.get("/activity", headers=asha["headers"]).json())
