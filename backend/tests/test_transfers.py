"""Customer-to-customer payments and the simulated ledger.

A transfer is prepared (review), face-verified with a basic liveness check, authorized by a single-use ticket bound to
that payment, explicitly confirmed, and only then posted to the ledger. Real PostgreSQL, synthetic face frames."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.models import LedgerEntry, PaymentAuthorization, PaymentSession, SecurityEvent, Transaction, User
from app.services import ledger_service
from tests.payment_helpers import authenticate, authorize, confirm, create_session, new_customer, set_threshold
from tests.transfer_helpers import net_moved, code, pay_transfer, prepare, prepared

pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes


OPENING = Decimal("0")  # nobody holds a balance now: tests compare net movement with zero


def dec(v):
    return Decimal(str(v))


def reconciled(db):
    db.expire_all()
    return ledger_service.reconcile(db)


def txns(db):
    db.expire_all()
    return list(db.scalars(select(Transaction).order_by(Transaction.id)))


# ============================================================ no wallet


def test_a_new_customer_has_no_wallet_balance_and_no_ledger_entries(client, db):
    c = new_customer(client, "Asha Rao", bank=False)
    assert client.get("/wallet", headers=c["headers"]).status_code == 404  # FacePay keeps no wallet
    db.expire_all()
    assert db.scalar(select(User.balance).where(User.id == c["id"])) == 0
    assert db.scalar(select(func.count()).select_from(LedgerEntry)) == 0
    assert reconciled(db) == []


def test_the_balance_cannot_be_set_from_the_outside(client, world):
    asha, _, _ = world
    assert client.patch("/users/me", json={"balance": "99999"}, headers=asha["headers"]).status_code == 422
    assert client.put("/wallet", json={"balance": "99999"}, headers=asha["headers"]).status_code in (404, 405)


def test_the_database_refuses_a_negative_balance(world, db):
    asha, _, _ = world
    with pytest.raises(IntegrityError):
        db.execute(text("update users set balance = -1 where id = :i"), {"i": asha["id"]})
        db.commit()
    db.rollback()


# ============================================================ the happy path


def test_a_verified_and_confirmed_transfer_is_recorded_once_with_its_funding_source(client, world, db):
    asha, ravi, _ = world
    r = pay_transfer(client, asha, ravi, "1250.50", note="Dinner split")
    assert r.status_code == 200, r.text
    receipt = r.json()
    assert receipt["kind"] == "TRANSFER" and receipt["status"] == "SUCCESS" and dec(receipt["amount"]) == dec("1250.50")
    assert receipt["payer_name"] == "Asha Rao" and receipt["recipient_name"] == "Ravi Shah" and receipt["note"] == "Dinner split"
    assert receipt["merchant_name"] is None and receipt["authentication"] == "Face + basic liveness check"
    assert dec(net_moved(client, asha)) == OPENING - dec("1250.50") and dec(net_moved(client, ravi)) == OPENING + dec("1250.50")

    (t,) = txns(db)
    assert (t.kind, t.payer_id, t.recipient_id, t.merchant_id, t.currency, t.note) == ("TRANSFER", asha["id"], ravi["id"], None, "INR", "Dinner split")
    # the transaction row is the record; it names the payer's demo bank account, and no ledger line or balance is touched
    assert (t.status, t.funding_bank_name, t.funding_account_ref) == ("SUCCESS", "HDFC Bank", asha["bank"]["account_ref"])
    assert receipt["funding_source"] == {"bank_name": "HDFC Bank", "account_ref": asha["bank"]["account_ref"]}
    assert db.scalar(select(func.count()).select_from(LedgerEntry)) == 0 and db.scalar(select(User.balance).where(User.id == asha["id"])) == 0

    # both participants can open the receipt; the history shows it from each side
    for who, direction in ((asha, "SENT"), (ravi, "RECEIVED")):
        got = client.get(f"/payments/transactions/{t.transaction_id}", headers=who["headers"])
        assert got.status_code == 200 and got.json()["transaction_id"] == t.transaction_id
        item = client.get("/activity", headers=who["headers"]).json()[0]
        assert (item["ref"], item["direction"], item["status"]) == (t.transaction_id, direction, "SUCCESS")


def test_nothing_is_debited_until_the_customer_confirms(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "700.00")
    assert dec(net_moved(client, asha)) == OPENING and txns(db) == []
    token = authorize(client, asha, sid)  # a successful face check alone moves no money
    assert dec(net_moved(client, asha)) == OPENING and txns(db) == []
    assert confirm(client, asha, sid, token).status_code == 200
    assert dec(net_moved(client, asha)) == OPENING - 700


def test_the_review_screen_shows_the_resolved_recipient_amount_and_note(client, world):
    asha, ravi, _ = world
    r = prepare(client, asha, ravi, "500.00", note="Rent")
    assert r.status_code == 201
    c = r.json()
    assert (c["kind"], c["recipient_name"], c["recipient_facepay_id"], c["note"], c["status"]) == ("TRANSFER", "Ravi Shah", ravi["facepay_id"], "Rent", "CREATED")
    assert dec(c["amount"]) == 500 and c["merchant_name"] is None and "balance" not in c
    assert dec(c["fee"]) == 0 and dec(c["total"]) == 500
    assert [f["connection_id"] for f in c["funding_sources"]] == [asha["bank"]["connection_id"]]  # her own accounts only
    assert "email" not in r.text.lower()


def test_ids_are_normalised_when_preparing(client, world):
    asha, ravi, _ = world
    r = prepare(client, asha, ravi["facepay_id"].upper().removesuffix("@FACEPAY"))
    assert r.status_code == 201 and r.json()["recipient_facepay_id"] == ravi["facepay_id"]


# ============================================================ validation, on the server


def test_unknown_recipient_creates_nothing(client, world, db):
    asha, _, _ = world
    r = prepare(client, asha, "ghost.user@facepay")
    assert r.status_code == 404 and code(r) == "RECIPIENT_NOT_FOUND"
    assert db.scalar(select(func.count()).select_from(PaymentSession)) == 0


def test_you_cannot_pay_yourself(client, world, db):
    asha, _, _ = world
    r = prepare(client, asha, asha)
    assert r.status_code == 422 and code(r) == "SELF_TRANSFER"
    assert db.scalar(select(func.count()).select_from(PaymentSession)) == 0


@pytest.mark.parametrize("amount", ["0", "-5", "0.00", "12.345", "abc", "", None, "1e3x", "1000001", "NaN", "Infinity"])
def test_invalid_amounts_are_refused(client, world, amount):
    asha, ravi, _ = world
    r = client.post("/transfers", json={"recipient_facepay_id": ravi["facepay_id"], "amount": amount}, headers=asha["headers"])
    assert r.status_code == 422, (amount, r.text)


def test_an_amount_above_the_per_payment_limit_is_refused(client, world, monkeypatch):
    asha, ravi, _ = world
    monkeypatch.setattr(get_settings(), "per_transaction_limit", Decimal("2000"))
    r = prepare(client, asha, ravi, "2000.01")
    assert r.status_code == 409 and code(r) == "PER_TRANSACTION_LIMIT"
    assert prepare(client, asha, ravi, "2000.00").status_code == 201


def test_the_daily_limit_counts_transfers_too(client, world, monkeypatch):
    asha, ravi, _ = world
    monkeypatch.setattr(get_settings(), "daily_payment_limit", Decimal("1500"))
    assert pay_transfer(client, asha, ravi, "1000.00").status_code == 200
    r = prepare(client, asha, ravi, "600.00")
    assert r.status_code == 409 and code(r) == "DAILY_LIMIT_EXCEEDED"


def test_a_note_is_length_limited_and_extra_fields_are_refused(client, world):
    asha, ravi, _ = world
    assert prepare(client, asha, ravi, note="x" * 141).status_code == 422
    r = client.post("/transfers", json={"recipient_facepay_id": ravi["facepay_id"], "amount": "5", "payer_id": 99, "status": "PAID"}, headers=asha["headers"])
    assert r.status_code == 422  # the payer is the signed-in customer; the client cannot name another


def test_a_note_is_stored_as_text_not_interpreted(client, world):
    asha, ravi, _ = world
    nasty = "<script>alert(1)</script>'; DROP TABLE users;--"
    r = pay_transfer(client, asha, ravi, "10.00", note=nasty)
    assert r.status_code == 200 and r.json()["note"] == nasty


def test_face_payments_switched_off_block_preparing_a_transfer(client, world):
    asha, ravi, _ = world
    assert client.put("/security/biometric", json={"enabled": False}, headers=asha["headers"]).status_code == 200
    r = prepare(client, asha, ravi)
    assert r.status_code == 403 and code(r) == "BIOMETRIC_DISABLED"


# ============================================================ funding source instead of a balance


def test_a_customer_with_no_connected_bank_can_review_and_verify_but_not_confirm(client, world, db):
    asha, ravi, _ = world
    assert client.delete(f"/banks/{asha['bank']['connection_id']}", headers=asha["headers"]).status_code == 200
    sid = prepared(client, asha, ravi, "300.00")
    assert client.get(f"/payments/sessions/{sid}", headers=asha["headers"]).json()["funding_sources"] == []
    token = authorize(client, asha, sid)
    r = confirm(client, asha, sid, token)
    assert r.status_code == 409 and code(r) == "NO_FUNDING_SOURCE"
    assert txns(db) == []


def test_there_is_no_balance_limit_only_the_payment_limits(client, world, db, monkeypatch):
    asha, ravi, _ = world
    monkeypatch.setattr(get_settings(), "step_up_amount_threshold", Decimal("100000"))  # large payments would otherwise ask for a PIN
    assert pay_transfer(client, asha, ravi, "10000.00").status_code == 200
    assert pay_transfer(client, asha, ravi, "10000.01").status_code == 200  # a wallet of 10,000 would have refused this
    assert len(txns(db)) == 2 and reconciled(db) == []


def test_disconnecting_the_bank_after_the_face_check_blocks_confirmation_and_moves_nothing(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "800.00")
    token = authorize(client, asha, sid)
    assert client.delete(f"/banks/{asha['bank']['connection_id']}", headers=asha["headers"]).status_code == 200
    r = confirm(client, asha, sid, token)
    assert r.status_code == 409 and code(r) == "NO_FUNDING_SOURCE"
    assert txns(db) == [] and db.scalar(select(PaymentSession.status)) == "AUTHENTICATED"  # the ticket is not burned
    again = client.post("/banks", json={"bank_code": "sbi"}, headers=asha["headers"]).json()
    ok = confirm(client, asha, sid, token)  # same ticket, new default account
    assert ok.status_code == 200 and ok.json()["funding_source"]["bank_name"] == "State Bank of India"
    assert ok.json()["funding_source"]["account_ref"] == again["account_ref"]


def test_decimal_money_has_no_floating_point_drift(client, world, db):
    asha, ravi, _ = world
    for amount in ("0.10", "0.20", "0.30", "33.33", "0.01"):
        assert pay_transfer(client, asha, ravi, amount).status_code == 200
    assert dec(net_moved(client, asha)) == OPENING - dec("33.94") and dec(net_moved(client, ravi)) == OPENING + dec("33.94")
    assert reconciled(db) == []


# ============================================================ authorization is bound to this payment


def test_nobody_but_the_payer_can_see_or_use_the_payment(client, world):
    asha, ravi, chitra = world
    sid = prepared(client, asha, ravi, "400.00")
    token = authorize(client, asha, sid)
    for stranger in (ravi, chitra):  # the recipient is a stranger to the payer's session too
        assert client.get(f"/payments/sessions/{sid}", headers=stranger["headers"]).status_code == 404
        assert client.post(f"/payments/sessions/{sid}/authenticate/start", headers=stranger["headers"]).status_code == 404
        r = client.post(f"/payments/sessions/{sid}/confirm", json={"authorization_token": token, "expected_amount": "400.00", "expected_recipient": ravi["facepay_id"]}, headers=stranger["headers"])
        assert r.status_code == 404 and code(r) == "SESSION_NOT_FOUND"
        assert client.post(f"/transfers/{sid}/cancel", headers=stranger["headers"]).status_code == 404
    assert confirm(client, asha, sid, token).status_code == 200


def test_the_confirmation_must_name_the_recipient_and_amount_that_were_shown(client, world, db):
    asha, ravi, chitra = world
    sid = prepared(client, asha, ravi, "400.00")
    token = authorize(client, asha, sid)
    wrong_person = confirm(client, asha, sid, token, expected_recipient=chitra["facepay_id"])
    assert wrong_person.status_code == 409 and code(wrong_person) == "RECIPIENT_MISMATCH"
    wrong_amount = confirm(client, asha, sid, token, expected_amount="4000.00")
    assert wrong_amount.status_code == 409 and code(wrong_amount) == "AMOUNT_MISMATCH"
    missing = client.post(f"/payments/sessions/{sid}/confirm", json={"authorization_token": token, "expected_amount": "400.00"}, headers=asha["headers"])
    assert missing.status_code == 422 and code(missing) == "EXPECTATION_MISSING"
    garbage = confirm(client, asha, sid, token, expected_recipient="not a valid id!!")
    assert garbage.status_code == 409 and code(garbage) == "RECIPIENT_MISMATCH"
    assert txns(db) == [] and dec(net_moved(client, asha)) == OPENING
    assert confirm(client, asha, sid, token).status_code == 200  # the right details still work: the ticket was not burned


def test_an_authorization_is_single_use_and_replay_is_rejected(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "300.00")
    token = authorize(client, asha, sid)
    assert confirm(client, asha, sid, token).status_code == 200
    again = confirm(client, asha, sid, token)
    assert again.status_code in (403, 409) and code(again) in ("AUTHORIZATION_USED", "SESSION_ALREADY_PAID")
    assert len(txns(db)) == 1 and dec(net_moved(client, asha)) == OPENING - 300


def test_a_ticket_for_one_payment_cannot_pay_another(client, world, db):
    asha, ravi, chitra = world
    first = prepared(client, asha, ravi, "100.00")
    second = prepared(client, asha, chitra, "100.00")
    token = authorize(client, asha, first)
    r = confirm(client, asha, second, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txns(db) == []


def test_a_ticket_for_a_merchant_bill_cannot_pay_a_transfer_or_the_reverse(client, world, shop, db):
    asha, ravi, _ = world
    bill = create_session(client, shop, amount="100.00", ref="SG-1")["session_id"]
    transfer = prepared(client, asha, ravi, "100.00")
    bill_token, transfer_token = authorize(client, asha, bill), authorize(client, asha, transfer)
    assert code(confirm(client, asha, transfer, bill_token)) == "AUTHORIZATION_INVALID"
    assert code(confirm(client, asha, bill, transfer_token)) == "AUTHORIZATION_INVALID"
    assert txns(db) == []


def test_an_authorization_issued_to_someone_else_is_useless(client, world):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    token = authorize(client, asha, sid)
    sid_ravi = prepared(client, ravi, asha, "100.00")
    r = confirm(client, ravi, sid_ravi, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"


def test_an_expired_authorization_is_refused(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    token = authorize(client, asha, sid)
    db.execute(update(PaymentAuthorization).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    r = confirm(client, asha, sid, token)
    assert r.status_code == 403 and code(r) in ("AUTHORIZATION_EXPIRED", "SESSION_EXPIRED") or code(r) == "AUTHORIZATION_INVALID"
    assert txns(db) == [] and dec(net_moved(client, asha)) == OPENING


def test_an_expired_review_cannot_be_authenticated_or_confirmed(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    db.execute(update(PaymentSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=asha["headers"])
    assert r.status_code == 409 and code(r) == "SESSION_EXPIRED"


def test_tampering_with_the_stored_recipient_after_authorization_voids_the_ticket(client, world, db):
    asha, ravi, chitra = world
    sid = prepared(client, asha, ravi, "100.00")
    token = authorize(client, asha, sid)
    db.execute(update(PaymentSession).where(PaymentSession.session_id == sid).values(payee_user_id=chitra["id"]))
    db.commit()
    r = client.post(f"/payments/sessions/{sid}/confirm", json={"authorization_token": token, "expected_amount": "100.00", "expected_recipient": chitra["facepay_id"]}, headers=asha["headers"])
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txns(db) == [] and dec(net_moved(client, chitra)) == OPENING


def test_tampering_with_the_stored_amount_after_authorization_voids_the_ticket(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    token = authorize(client, asha, sid)
    db.execute(update(PaymentSession).where(PaymentSession.session_id == sid).values(amount=Decimal("9000")))
    db.commit()
    r = client.post(f"/payments/sessions/{sid}/confirm", json={"authorization_token": token, "expected_amount": "9000.00", "expected_recipient": ravi["facepay_id"]}, headers=asha["headers"])
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID" and txns(db) == []


def test_retraining_the_model_after_the_face_check_voids_the_ticket(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    token = authorize(client, asha, sid)
    assert client.post("/faces/train", headers=asha["headers"]).status_code == 200
    set_threshold(db, [asha["id"], ravi["id"]], 1000.0)
    r = confirm(client, asha, sid, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID" and txns(db) == []


def test_a_large_transfer_asks_for_the_payment_pin(client, world, db, monkeypatch):
    asha, ravi, _ = world
    monkeypatch.setattr(get_settings(), "step_up_amount_threshold", Decimal("1000"))
    monkeypatch.setattr(get_settings(), "step_up_pin_change_minutes", 0)
    assert client.put("/security/pin", json={"password": "Correct-horse-42", "new_pin": "482915"}, headers=asha["headers"]).status_code == 200
    sid = prepared(client, asha, ravi, "1500.00")
    auth = authenticate(client, asha, sid).json()["authorization"]
    assert auth["step_up_required"] is True
    token = auth["authorization_token"]
    assert code(confirm(client, asha, sid, token)) == "PIN_REQUIRED"
    assert code(confirm(client, asha, sid, token, pin="000000")) == "PIN_INCORRECT"
    assert txns(db) == []
    ok = confirm(client, asha, sid, token, pin="482915")
    assert ok.status_code == 200 and ok.json()["authentication"] == "Face + basic liveness check + payment PIN"


def test_a_wrong_face_pays_nothing(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    r = authenticate(client, asha, sid, identity=1)  # Ravi's face on Asha's session
    assert r.json()["result"] == "REJECTED" and r.json()["authorization"] is None
    assert txns(db) == [] and dec(net_moved(client, asha)) == OPENING


# ============================================================ cancel, idempotency, duplicates


def test_the_payer_can_back_out_and_the_ticket_dies_with_it(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "100.00")
    token = authorize(client, asha, sid)
    r = client.post(f"/transfers/{sid}/cancel", headers=asha["headers"])
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"
    c = confirm(client, asha, sid, token)
    assert c.status_code == 409 and code(c) == "SESSION_CANCELLED" and txns(db) == []
    assert client.post(f"/transfers/{sid}/cancel", headers=asha["headers"]).status_code == 409
    item = client.get("/activity", params={"filter": "cancelled"}, headers=asha["headers"]).json()
    assert [(i["ref"], i["status"]) for i in item] == [(sid, "CANCELLED")]


def test_the_same_idempotency_key_returns_the_same_payment(client, world, db):
    asha, ravi, chitra = world
    first = prepare(client, asha, ravi, "250.00", key="key-abcdef-1")
    again = prepare(client, asha, ravi, "250.00", key="key-abcdef-1")
    assert first.status_code == again.status_code == 201 and first.json()["session_id"] == again.json()["session_id"]
    assert db.scalar(select(func.count()).select_from(PaymentSession)) == 1
    clash = prepare(client, asha, ravi, "251.00", key="key-abcdef-1")
    assert clash.status_code == 409 and code(clash) == "IDEMPOTENCY_CONFLICT"
    other_recipient = prepare(client, asha, chitra, "250.00", key="key-abcdef-1")
    assert other_recipient.status_code == 409 and code(other_recipient) == "IDEMPOTENCY_CONFLICT"
    # keys are per customer: Ravi using the same text gets his own payment
    theirs = prepare(client, ravi, asha, "250.00", key="key-abcdef-1")
    assert theirs.status_code == 201 and theirs.json()["session_id"] != first.json()["session_id"]


def test_a_malformed_idempotency_key_is_refused(client, world):
    asha, ravi, _ = world
    for key in ("short", "has space in it!!", "x" * 80):
        assert prepare(client, asha, ravi, key=key).status_code == 422


def test_a_retried_idempotent_payment_cannot_be_paid_twice(client, world, db):
    asha, ravi, _ = world
    sid = prepare(client, asha, ravi, "250.00", key="retry-key-1").json()["session_id"]
    token = authorize(client, asha, sid)
    assert confirm(client, asha, sid, token).status_code == 200
    reopened = prepare(client, asha, ravi, "250.00", key="retry-key-1")  # the app retries the review after a flaky network
    assert reopened.json()["session_id"] == sid and reopened.json()["status"] == "PAID"
    r = confirm(client, asha, sid, token)
    assert r.status_code in (403, 409)
    assert len(txns(db)) == 1 and dec(net_moved(client, asha)) == OPENING - 250


def test_simultaneous_confirmations_move_the_money_exactly_once(client, world, db):
    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "400.00")
    token = authorize(client, asha, sid)
    body = {"authorization_token": token, "expected_amount": "400.00", "expected_recipient": ravi["facepay_id"]}
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: client.post(f"/payments/sessions/{sid}/confirm", json=body, headers=asha["headers"]), range(6)))
    statuses = sorted(r.status_code for r in results)
    assert statuses.count(200) == 1 and all(s in (200, 403, 409) for s in statuses), statuses
    assert len(txns(db)) == 1
    assert dec(net_moved(client, asha)) == OPENING - 400 and dec(net_moved(client, ravi)) == OPENING + 400
    assert reconciled(db) == []


def test_two_payments_confirmed_at_the_same_time_are_both_recorded_once(client, world, db):
    asha, ravi, chitra = world
    first, second = prepared(client, asha, ravi, "6000.00"), prepared(client, asha, chitra, "6000.00")
    tokens = {first: authorize(client, asha, first), second: authorize(client, asha, second)}
    destinations = {first: ravi, second: chitra}

    def go(sid):
        body = {"authorization_token": tokens[sid], "expected_amount": "6000.00", "expected_recipient": destinations[sid]["facepay_id"]}
        return client.post(f"/payments/sessions/{sid}/confirm", json=body, headers=asha["headers"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(go, [first, second]))
    assert sorted(r.status_code for r in results) == [200, 200]  # no balance to overdraw; each ticket belongs to its own payment
    assert len(txns(db)) == 2 and dec(net_moved(client, asha)) == OPENING - 12000


# ============================================================ atomicity


def test_a_crash_before_the_commit_rolls_everything_back(client, world, db, monkeypatch):
    from app.services import payment_service as pay
    from app.services import security_service as sec

    asha, ravi, _ = world
    sid = prepared(client, asha, ravi, "500.00")
    token = authorize(client, asha, sid)
    real = sec.record_event

    def flaky(db_, user, kind, *a, **kw):
        if kind == "PAYMENT_CONFIRMED":  # after the transaction row was added and the ticket consumed, before the commit
            raise RuntimeError("simulated crash just before the payment was committed")
        return real(db_, user, kind, *a, **kw)

    monkeypatch.setattr(sec, "record_event", flaky)
    with pytest.raises(RuntimeError):
        confirm(client, asha, sid, token)
    monkeypatch.undo()
    db.expire_all()
    assert txns(db) == []  # no transaction row, no consumed ticket, no PAID session
    assert db.scalar(select(PaymentAuthorization.status)) == "ACTIVE"
    assert db.scalar(select(PaymentSession.status).where(PaymentSession.session_id == sid)) == "AUTHENTICATED"
    assert confirm(client, asha, sid, token).status_code == 200  # and the same ticket still works afterwards
    assert len(txns(db)) == 1 and dec(net_moved(client, ravi)) == OPENING + 500
    assert pay is not None


def test_net_movement_is_conserved_after_many_mixed_payments(client, world, shop, db):
    asha, ravi, chitra = world
    pay_transfer(client, asha, ravi, "1200.00")
    pay_transfer(client, ravi, chitra, "300.25", identity=1)
    pay_transfer(client, ravi, asha, "75.75", identity=1)
    bill = create_session(client, shop, amount="480.00", ref="SG-77")["session_id"]
    assert confirm(client, asha, bill, authorize(client, asha, bill)).status_code == 200
    # transfers only move money between customers; the 480 went to the merchant
    assert sum(dec(net_moved(client, c)) for c in (asha, ravi, chitra)) == -480
    assert len(txns(db)) == 4 and reconciled(db) == []
    assert db.scalar(select(func.count()).select_from(LedgerEntry)) == 0


def test_reconcile_notices_a_balance_that_does_not_match_its_ledger(client, world, db):
    asha, ravi, _ = world
    pay_transfer(client, asha, ravi, "100.00")
    db.execute(text("update users set balance = balance + 1 where id = :i"), {"i": asha["id"]})
    db.commit()
    problems = ledger_service.reconcile(db)
    assert len(problems) == 1 and "USER" in problems[0]


def test_the_database_refuses_a_ledger_line_that_is_not_positive(world, db):
    asha, _, _ = world
    db.add(LedgerEntry(account_type="USER", account_id=asha["id"], direction="CREDIT", amount=Decimal("0"), balance_after=Decimal("1"), kind="TRANSFER"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_the_database_refuses_a_transaction_with_neither_or_both_payees(client, world, db, shop):
    asha, ravi, _ = world
    for kwargs in ({"merchant_id": None, "recipient_id": None, "kind": "TRANSFER"}, {"merchant_id": shop["id"], "recipient_id": ravi["id"], "kind": "TRANSFER"},
                   {"merchant_id": None, "recipient_id": asha["id"], "kind": "TRANSFER"}):  # last one: paying yourself
        db.add(Transaction(transaction_id="FP-BADSHAPE01", payer_id=asha["id"], amount=Decimal("1"), status="SUCCESS", **kwargs))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


# ============================================================ merchant payments


def test_a_merchant_payment_is_recorded_for_the_customer_and_the_merchant(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="950.00", ref="SG-10492")["session_id"]
    r = confirm(client, asha, sid, authorize(client, asha, sid))
    assert r.status_code == 200 and r.json()["kind"] == "MERCHANT_PAYMENT" and r.json()["merchant_name"] == "SuperGrocery"
    assert dec(net_moved(client, asha)) == OPENING - 950
    (t,) = txns(db)
    assert (t.merchant_id, t.payer_id, t.amount, t.status) == (shop["id"], asha["id"], dec("950.00"), "SUCCESS")
    assert reconciled(db) == []
    assert client.get("/merchant/summary", headers=shop["headers"]).json()["total_revenue"] in ("950.00", 950, "950")


# ============================================================ audit trail


def test_the_audit_trail_records_the_payment_without_biometric_detail(client, world, db):
    asha, ravi, _ = world
    pay_transfer(client, asha, ravi, "100.00")
    db.expire_all()
    kinds = [e.kind for e in db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == asha["id"]))]
    assert "PAYMENT_CONFIRMED" in kinds
    overview = client.get("/security/overview", headers=asha["headers"]).json()
    assert overview["recent_transactions"][0]["merchant_name"] == "To Ravi Shah"


def test_cors_preflight_allows_the_idempotency_key_header(client):
    """The browser sends Idempotency-Key on transfers; a preflight that does not allow it blocks every payment."""
    origin = "http://localhost:5173"
    r = client.options(
        "/transfers",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "authorization,content-type,idempotency-key"},
    )
    assert r.status_code == 200, r.text
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "idempotency-key" in allowed
