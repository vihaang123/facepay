"""Face-first payments: merchant payment requests and links, simulated bank accounts as funding sources (no wallet
balance), confirmation and receipts that name the account, the simulated "nearby" list, and merchant reconciliation.

Real PostgreSQL. Camera frames are synthetic scenes; the recognition code behind them is the unchanged production code.
These are automated tests, not a hosted run: nothing here touches Render or Vercel."""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.core import banks as bank_catalog
from app.models import BankConnection, LedgerEntry, PaymentAuthorization, PaymentSession, SecurityEvent, Transaction, User
from tests.payment_helpers import authenticate, authorize, confirm, connect_bank, create_session, new_customer
from tests.transfer_helpers import code, pay_transfer, prepare, prepared

pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes

DEMO_REF = re.compile(r"^DEMO-••••-\d{4}$")


def dec(v):
    return Decimal(str(v))


def txns(db):
    db.expire_all()
    return list(db.scalars(select(Transaction).order_by(Transaction.id)))


def checkout(client, cust, sid):
    r = client.get(f"/payments/sessions/{sid}", headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def banks_of(client, cust):
    return client.get("/banks", headers=cust["headers"]).json()


def expire(db, sid):
    db.execute(PaymentSession.__table__.update().where(PaymentSession.session_id == sid).values(expires_at=datetime.now(UTC) - timedelta(seconds=5)))
    db.commit()


# ============================================================ 1-3 a merchant payment request and its link


def test_a_merchant_creates_a_payment_request_with_a_secure_link_and_every_field(client, shop):
    r = client.post(
        "/merchant/payment-sessions",
        json={"amount": "499.00", "order_reference": "ORD-1001", "description": "Cold brew x2", "expires_in_minutes": 20, "discoverable": True},
        headers=shop["headers"],
    )
    assert r.status_code == 201, r.text
    s = r.json()
    assert dec(s["amount"]) == 499 and s["currency"] == "INR" and s["order_reference"] == "ORD-1001" and s["description"] == "Cold brew x2"
    assert s["status"] == "CREATED" and s["discoverable"] is True and s["expires_at"] and s["transaction_id"] is None and s["paid_at"] is None
    assert s["checkout_path"] == f"/checkout/{s['session_id']}"
    assert len(s["session_id"]) >= 20 and s["session_id"].startswith("ps_")  # an unguessable bearer token, not a counter


def test_the_customer_who_opens_the_link_sees_the_right_merchant_amount_and_order(client, world, shop):
    asha, _, _ = world
    s = create_session(client, shop, amount="499.00", ref="ORD-1001", description="Cold brew x2")
    c = checkout(client, asha, s["session_id"])
    assert (c["kind"], c["merchant_name"], c["order_reference"], c["description"], c["status"]) == ("MERCHANT", "SuperGrocery", "ORD-1001", "Cold brew x2", "CREATED")
    assert dec(c["amount"]) == 499 and c["currency"] == "INR" and dec(c["fee"]) == 0 and dec(c["total"]) == 499
    assert "balance" not in c and "email" not in str(c).lower()


def test_an_unknown_payment_link_is_just_not_found(client, world):
    asha, _, _ = world
    assert client.get("/payments/sessions/ps_doesnotexist0000000000", headers=asha["headers"]).status_code == 404


# ============================================================ 4 paying a person: the recipient is explicit


def test_the_recipient_of_a_person_payment_comes_from_the_chosen_facepay_id_only(client, world):
    asha, ravi, _ = world
    c = prepare(client, asha, ravi, "250.00", note="Lunch").json()
    assert (c["kind"], c["recipient_name"], c["recipient_facepay_id"]) == ("TRANSFER", "Ravi Shah", ravi["facepay_id"])
    # there is no way to name a recipient by anything else, and a face is never used to pick one
    r = client.post("/transfers", json={"recipient_facepay_id": ravi["facepay_id"], "amount": "5.00", "payee_user_id": 1}, headers=asha["headers"])
    assert r.status_code == 422
    assert prepare(client, asha, "nobody.here@facepay").status_code == 404


# ============================================================ 5-7 simulated bank accounts


def test_connecting_a_demo_bank_creates_a_record_only_and_the_first_becomes_the_default(client, db):
    c = new_customer(client, "Dana Mehta", bank=False)
    r = client.post("/banks", json={"bank_code": "sbi"}, headers=c["headers"])
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["bank_name"] == "State Bank of India" and b["account_type"] in ("SAVINGS", "SALARY") and b["is_default"] is True and b["status"] == "CONNECTED"
    assert DEMO_REF.match(b["account_ref"]) and "Demo connection only" in b["disclaimer"]
    row = db.scalar(select(BankConnection))
    assert row.user_id == c["id"] and row.account_last4 == b["account_ref"][-4:]
    # nothing but a bank code is accepted: no names, types, numbers, passwords, PINs or OTPs
    for extra in ({"bank_name": "Fake Bank"}, {"account_type": "SAVINGS"}, {"holder_name": "Someone Else"}, {"password": "x"}, {"account_number": "123456789012"}, {"otp": "123456"}, {"pin": "1234"}):
        assert client.post("/banks", json={"bank_code": "hdfc", **extra}, headers=c["headers"]).status_code == 422
    assert db.scalar(select(func.count()).select_from(BankConnection)) == 1


def test_the_catalog_lists_the_required_indian_banks_and_the_demo_disclaimer(client, world):
    asha, _, _ = world
    cat = client.get("/banks/catalog", headers=asha["headers"]).json()
    names = {b["name"] for b in cat["banks"]}
    for required in (
        "State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Punjab National Bank", "Bank of Baroda",
        "Canara Bank", "Union Bank of India", "IDFC FIRST Bank", "IndusInd Bank", "Yes Bank",
    ):
        assert required in names
    assert cat["disclaimer"] == bank_catalog.DEMO_DISCLAIMER == "Demo connection only. No real bank account is accessed and no money is transferred."
    assert "account_types" not in cat  # the customer no longer picks a type: the discovery provider reports it


def test_unknown_banks_duplicates_and_the_limit_are_refused(client, db):
    c = new_customer(client, "Dana Mehta", bank=False)
    post = lambda **kw: client.post("/banks", json=kw, headers=c["headers"])  # noqa: E731
    assert post(bank_code="notabank").status_code == 422
    assert post(bank_code="sbi").status_code == 201
    dup = post(bank_code="sbi")
    assert dup.status_code == 409 and code(dup) == "BANK_ALREADY_CONNECTED"
    for bank in ("hdfc", "icici", "axis", "kotak"):
        assert post(bank_code=bank).status_code == 201
    over = post(bank_code="pnb")
    assert over.status_code == 409 and code(over) == "BANK_LIMIT"
    assert db.scalar(select(func.count()).select_from(BankConnection)) == bank_catalog.MAX_CONNECTED_BANKS


def test_the_default_can_be_changed_and_disconnecting_the_default_promotes_another(client, db):
    c = new_customer(client, "Dana Mehta", bank=False)
    a = connect_bank(client, c, "sbi")
    b = connect_bank(client, c, "icici")
    assert (a["is_default"], b["is_default"]) == (True, False)
    r = client.post(f"/banks/{b['connection_id']}/default", headers=c["headers"])
    assert r.status_code == 200 and r.json()["is_default"] is True
    listed = banks_of(client, c)
    assert [(x["bank_name"], x["is_default"]) for x in listed] == [("ICICI Bank", True), ("State Bank of India", False)]
    assert client.delete(f"/banks/{b['connection_id']}", headers=c["headers"]).status_code == 200
    listed = banks_of(client, c)
    assert [(x["bank_name"], x["is_default"]) for x in listed] == [("State Bank of India", True)]  # the remaining one took over
    assert client.delete(f"/banks/{a['connection_id']}", headers=c["headers"]).status_code == 200
    assert banks_of(client, c) == []
    assert client.delete(f"/banks/{a['connection_id']}", headers=c["headers"]).status_code == 404  # already gone
    kinds = {e.kind for e in db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == c["id"]))}
    assert {"BANK_CONNECTED", "BANK_DEFAULT_CHANGED", "BANK_DISCONNECTED"} <= kinds


def test_two_simultaneous_connections_leave_exactly_one_default(client, db):
    c = new_customer(client, "Dana Mehta", bank=False)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda code_: client.post("/banks", json={"bank_code": code_}, headers=c["headers"]), ["sbi", "hdfc", "icici", "axis"]))
    assert all(r.status_code == 201 for r in results)
    assert sum(1 for b in banks_of(client, c) if b["is_default"]) == 1


def test_the_checkout_offers_the_customers_own_accounts_and_marks_the_default(client, world, shop):
    asha, ravi, _ = world
    second = connect_bank(client, asha, "axis")
    sid = create_session(client, shop)["session_id"]
    sources = checkout(client, asha, sid)["funding_sources"]
    assert [(s["bank_name"], s["is_default"]) for s in sources] == [("HDFC Bank", True), ("Axis Bank", False)]
    assert second["connection_id"] in str(sources)
    # Ravi sees only his own
    mine = checkout(client, ravi, sid)["funding_sources"]
    assert [s["connection_id"] for s in mine] == [ravi["bank"]["connection_id"]]
    assert asha["bank"]["connection_id"] not in str(mine) and second["connection_id"] not in str(mine)


def test_the_chosen_account_is_the_one_on_the_receipt_the_history_and_the_transaction(client, world, shop, db):
    asha, _, _ = world
    chosen = connect_bank(client, asha, "icici")
    sid = create_session(client, shop, amount="499.00", ref="ORD-1001")["session_id"]
    r = confirm(client, asha, sid, authorize(client, asha, sid), funding_source_id=chosen["connection_id"])
    assert r.status_code == 200, r.text
    receipt = r.json()
    assert receipt["funding_source"] == {"bank_name": "ICICI Bank", "account_ref": chosen["account_ref"]}
    assert dec(receipt["fee"]) == 0 and dec(receipt["total"]) == 499 and receipt["order_reference"] == "ORD-1001" and "No real bank" in receipt["simulation_notice"]
    (t,) = txns(db)
    assert (t.funding_bank_name, t.funding_account_ref) == ("ICICI Bank", chosen["account_ref"])
    assert db.get(BankConnection, t.funding_source_id).connection_id == chosen["connection_id"]
    # the receipt endpoint and the history show the same account to the payer
    again = client.get(f"/payments/transactions/{t.transaction_id}", headers=asha["headers"]).json()
    assert again["funding_source"] == receipt["funding_source"]
    item = client.get("/activity", headers=asha["headers"]).json()[0]
    assert item["funding_source"] == f"ICICI Bank · {chosen['account_ref']}" and item["status"] == "SUCCESS"
    detail = client.get(f"/activity/{t.transaction_id}", headers=asha["headers"]).json()
    assert detail["funding_source"] == item["funding_source"]


def test_without_a_named_account_the_default_is_used(client, world, shop):
    asha, _, _ = world
    connect_bank(client, asha, "axis")
    sid = create_session(client, shop)["session_id"]
    r = confirm(client, asha, sid, authorize(client, asha, sid))
    assert r.status_code == 200 and r.json()["funding_source"]["bank_name"] == "HDFC Bank"


def test_the_recipient_and_the_merchant_never_see_the_payers_bank_account(client, world, shop, db):
    asha, ravi, _ = world
    t1 = pay_transfer(client, asha, ravi, "100.00").json()["transaction_id"]
    sid = create_session(client, shop, amount="50.00", ref="SG-1")["session_id"]
    t2 = confirm(client, asha, sid, authorize(client, asha, sid)).json()["transaction_id"]
    # the recipient of the transfer
    got = client.get(f"/payments/transactions/{t1}", headers=ravi["headers"]).json()
    assert got["funding_source"] is None and "DEMO-" not in str(got) and "HDFC" not in str(got)
    item = [i for i in client.get("/activity", headers=ravi["headers"]).json() if i["ref"] == t1][0]
    assert item["direction"] == "RECEIVED" and item["funding_source"] is None
    assert "DEMO-" not in str(client.get(f"/activity/{t1}", headers=ravi["headers"]).json())
    # the merchant
    m = client.get(f"/merchant/transactions/{t2}", headers=shop["headers"]).json()
    assert m["funding_source"] is None and "DEMO-" not in str(m) and "HDFC" not in str(m)
    assert "DEMO-" not in str(client.get("/merchant/transactions", headers=shop["headers"]).json())


# ============================================================ no wallet


def test_there_is_no_wallet_no_balance_and_no_ledger_movement(client, world, shop, db):
    asha, ravi, _ = world
    assert client.get("/wallet", headers=asha["headers"]).status_code == 404
    pay_transfer(client, asha, ravi, "1000.00")
    sid = create_session(client, shop, amount="25.00")["session_id"]
    confirm(client, asha, sid, authorize(client, asha, sid))
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(LedgerEntry)) == 0
    assert {b for (b,) in db.execute(select(User.balance))} == {0}
    for path in ("/payments/summary", "/activity", "/facepay/me", "/banks"):
        assert "balance" not in client.get(path, headers=asha["headers"]).text.lower(), path


def test_history_made_under_the_old_wallet_stays_intact_and_consistent_after_new_payments(client, world, shop, db):
    """A customer who paid under the previous wallet design keeps their balance column, ledger rows and transaction. A new
    payment neither reads nor changes them, the old payment shows in history with no funding source, and reconcile() agrees."""
    from app.models import Merchant
    from app.services import ledger_service

    asha, _, _ = world
    merchant_pk = db.scalar(select(Merchant.id).where(Merchant.id == shop["id"]))
    legacy = Transaction(transaction_id="FP-LEGACY0001", payer_id=asha["id"], merchant_id=merchant_pk, amount=Decimal("1000.00"),
                         payment_method="FACE_PAY", status="SUCCESS", timestamp=datetime.now(UTC) - timedelta(days=30))
    db.add(legacy)
    db.flush()
    db.add_all([
        LedgerEntry(account_type="USER", account_id=asha["id"], direction="CREDIT", amount=Decimal("10000.00"), balance_after=Decimal("10000.00"), kind="OPENING_GRANT"),
        LedgerEntry(account_type="USER", account_id=asha["id"], direction="DEBIT", amount=Decimal("1000.00"), balance_after=Decimal("9000.00"), kind="MERCHANT_PAYMENT", transaction_id=legacy.id),
        LedgerEntry(account_type="MERCHANT", account_id=merchant_pk, direction="CREDIT", amount=Decimal("1000.00"), balance_after=Decimal("1000.00"), kind="MERCHANT_PAYMENT", transaction_id=legacy.id),
    ])
    db.execute(User.__table__.update().where(User.id == asha["id"]).values(balance=Decimal("9000.00")))
    db.execute(Merchant.__table__.update().where(Merchant.id == merchant_pk).values(balance=Decimal("1000.00")))
    db.commit()
    assert ledger_service.reconcile(db) == []

    sid = create_session(client, shop, amount="250.00", ref="ORD-NEW")["session_id"]
    r = confirm(client, asha, sid, authorize(client, asha, sid))
    assert r.status_code == 200 and r.json()["funding_source"]["bank_name"] == asha["bank"]["bank_name"]

    db.expire_all()
    assert db.scalar(select(User.balance).where(User.id == asha["id"])) == Decimal("9000.00")  # untouched by the new payment
    assert db.scalar(select(func.count()).select_from(LedgerEntry)) == 3  # nothing was added
    assert ledger_service.reconcile(db) == []
    history = {a["ref"]: a for a in client.get("/activity?limit=51", headers=asha["headers"]).json()}
    assert history["FP-LEGACY0001"]["funding_source"] is None and history["FP-LEGACY0001"]["status"] == "SUCCESS"
    assert history[r.json()["transaction_id"]]["funding_source"] is not None
    rec = client.get("/merchant/reconciliation", headers=shop["headers"]).json()
    assert dec(rec["paid_total"]) == Decimal("1250.00")  # the old payment and the new one
    assert rec["mismatches"] == 0


# ============================================================ 8-9 authorization is transaction-specific; confirmation is explicit


def test_face_authentication_alone_creates_an_authorization_for_this_payment_and_no_transaction(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00", ref="ORD-1001")["session_id"]
    token = authorize(client, asha, sid)
    assert txns(db) == []  # recognition establishes identity; it does not pay
    auth = db.scalar(select(PaymentAuthorization))
    ps = db.scalar(select(PaymentSession))
    assert (auth.payment_session_id, auth.user_id, auth.merchant_id, auth.amount, auth.order_reference, auth.status) == (ps.id, asha["id"], shop["id"], dec("499.00"), "ORD-1001", "ACTIVE")
    assert auth.token_hash != token and token not in str(auth.__dict__)  # only a hash is stored
    assert 0 < (auth.expires_at - datetime.now(UTC)).total_seconds() <= 120
    assert ps.status == "AUTHENTICATED"


def test_an_authorization_for_one_payment_cannot_pay_another(client, world, shop, db):
    asha, _, _ = world
    first = create_session(client, shop, amount="100.00", ref="A-1")["session_id"]
    second = create_session(client, shop, amount="100.00", ref="A-2")["session_id"]
    token = authorize(client, asha, first)
    r = confirm(client, asha, second, token)
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txns(db) == []
    assert confirm(client, asha, first, token).status_code == 200  # it still pays the payment it was issued for


def test_confirming_with_a_different_amount_merchant_or_recipient_than_shown_pays_nothing(client, world, shop, db):
    asha, ravi, _ = world
    sid = create_session(client, shop, amount="100.00", ref="A-1")["session_id"]
    token = authorize(client, asha, sid)
    assert code(confirm(client, asha, sid, token, expected_amount="1.00")) == "AMOUNT_MISMATCH"
    assert code(confirm(client, asha, sid, token, expected_merchant="Other Shop")) == "MERCHANT_MISMATCH"
    tsid = prepared(client, asha, ravi, "10.00")
    ttoken = authorize(client, asha, tsid)
    assert code(confirm(client, asha, tsid, ttoken, expected_recipient="someone.else@facepay")) == "RECIPIENT_MISMATCH"
    assert txns(db) == []


def test_explicit_confirmation_completes_exactly_one_transaction(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00", ref="ORD-1001")["session_id"]
    token = authorize(client, asha, sid)
    r = confirm(client, asha, sid, token)
    assert r.status_code == 200 and r.json()["status"] == "SUCCESS"
    (t,) = txns(db)
    assert (t.payer_id, t.merchant_id, t.amount, t.status, t.payment_session_id) == (asha["id"], shop["id"], dec("499.00"), "SUCCESS", db.scalar(select(PaymentSession.id)))
    assert db.scalar(select(PaymentSession.status)) == "PAID" and db.scalar(select(PaymentAuthorization.status)) == "CONSUMED"


# ============================================================ 11 cancelling at the confirmation screen


def test_cancelling_at_confirmation_voids_the_authorization_and_pays_nothing(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00", ref="ORD-1001")["session_id"]
    token = authorize(client, asha, sid)
    r = client.post(f"/payments/sessions/{sid}/authorization/cancel", headers=asha["headers"])
    assert r.status_code == 200 and r.json() == {"session_id": sid, "status": "CREATED"}
    assert txns(db) == []
    assert db.scalar(select(PaymentAuthorization.status)) == "REVOKED"
    again = confirm(client, asha, sid, token)  # the abandoned face check can no longer pay
    assert again.status_code == 403 and txns(db) == []
    # the customer can still start over and pay
    assert confirm(client, asha, sid, authorize(client, asha, sid)).status_code == 200


def test_only_the_payer_can_cancel_their_own_authorization(client, world, shop, db):
    asha, ravi, _ = world
    tsid = prepared(client, asha, ravi, "40.00")  # a person payment belongs to Asha alone
    token = authorize(client, asha, tsid)
    assert client.post(f"/payments/sessions/{tsid}/authorization/cancel", headers=ravi["headers"]).status_code == 404
    assert db.scalar(select(PaymentAuthorization.status)) == "ACTIVE"
    assert confirm(client, asha, tsid, token).status_code == 200


# ============================================================ 12 expiry


def test_an_expired_request_cannot_be_authenticated_or_paid(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00")["session_id"]
    expire(db, sid)
    assert checkout(client, asha, sid)["status"] == "EXPIRED"
    r = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=asha["headers"])
    assert r.status_code == 409 and code(r) == "SESSION_EXPIRED"
    assert txns(db) == []


def test_a_request_that_expires_after_the_face_check_cannot_be_confirmed(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00")["session_id"]
    token = authorize(client, asha, sid)
    expire(db, sid)
    r = confirm(client, asha, sid, token)
    assert r.status_code == 409 and code(r) == "SESSION_EXPIRED"
    assert txns(db) == []


# ============================================================ 13-15 isolation and replay


def test_another_customer_cannot_use_someone_elses_authorization(client, world, shop, db):
    asha, ravi, _ = world
    sid = create_session(client, shop, amount="100.00")["session_id"]
    token = authorize(client, asha, sid)
    r = confirm(client, ravi, sid, token)  # Ravi holds Asha's one-time token for a payment Ravi could also open
    assert r.status_code == 403 and code(r) == "AUTHORIZATION_INVALID"
    assert txns(db) == []
    tsid = prepared(client, asha, ravi, "30.00")  # and a person payment is invisible to anyone but its payer
    ttoken = authorize(client, asha, tsid)
    assert confirm(client, ravi, tsid, ttoken).status_code == 404
    assert txns(db) == []


def test_replaying_a_used_authorization_cannot_create_a_second_transaction(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="100.00")["session_id"]
    token = authorize(client, asha, sid)
    assert confirm(client, asha, sid, token).status_code == 200
    for _ in range(3):
        r = confirm(client, asha, sid, token)
        assert r.status_code in (403, 409)
    assert len(txns(db)) == 1
    other = create_session(client, shop, amount="100.00", ref="NEXT")["session_id"]
    assert confirm(client, asha, other, token).status_code in (403, 409)  # an old face check never authorizes a new payment
    assert len(txns(db)) == 1


def test_a_customer_cannot_read_or_change_another_customers_bank_connection(client, world, db):
    asha, ravi, _ = world
    theirs = asha["bank"]["connection_id"]
    assert theirs not in str(banks_of(client, ravi))
    assert client.post(f"/banks/{theirs}/default", headers=ravi["headers"]).status_code == 404
    assert client.delete(f"/banks/{theirs}", headers=ravi["headers"]).status_code == 404
    db.expire_all()
    row = db.scalar(select(BankConnection).where(BankConnection.connection_id == theirs))
    assert row.status == "CONNECTED" and row.is_default is True  # untouched
    assert len(banks_of(client, asha)) == 1


def test_paying_from_someone_elses_bank_account_is_refused(client, world, shop, db):
    asha, ravi, _ = world
    sid = create_session(client, shop, amount="100.00")["session_id"]
    token = authorize(client, asha, sid)
    r = confirm(client, asha, sid, token, funding_source_id=ravi["bank"]["connection_id"])
    assert r.status_code == 409 and code(r) == "FUNDING_SOURCE_INVALID"
    assert confirm(client, asha, sid, token, funding_source_id="bk_made_up_value").status_code == 409
    assert txns(db) == []
    assert confirm(client, asha, sid, token).status_code == 200  # the ticket survived the refused attempts


def test_a_disconnected_account_cannot_be_paid_from_but_old_receipts_keep_its_name(client, world, shop, db):
    asha, _, _ = world
    extra = connect_bank(client, asha, "sbi")
    sid = create_session(client, shop, amount="60.00")["session_id"]
    assert confirm(client, asha, sid, authorize(client, asha, sid), funding_source_id=extra["connection_id"]).status_code == 200
    assert client.delete(f"/banks/{extra['connection_id']}", headers=asha["headers"]).status_code == 200
    (t,) = txns(db)
    receipt = client.get(f"/payments/transactions/{t.transaction_id}", headers=asha["headers"]).json()
    assert receipt["funding_source"]["bank_name"] == "State Bank of India"  # a snapshot, not a live lookup
    again = create_session(client, shop, amount="10.00", ref="N-2")["session_id"]
    r = confirm(client, asha, again, authorize(client, asha, again), funding_source_id=extra["connection_id"])
    assert r.status_code == 409 and code(r) == "FUNDING_SOURCE_INVALID"


# ============================================================ 16 the merchant sees "paid" only after the backend says so


def test_the_merchant_sees_a_payment_only_after_the_backend_confirms_it(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00", ref="ORD-1001")["session_id"]
    seen = lambda: client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()  # noqa: E731
    assert seen()["status"] == "CREATED" and seen()["transaction_id"] is None

    token = authorize(client, asha, sid)  # the customer has been recognised ...
    assert seen()["status"] == "AUTHENTICATED" and seen()["transaction_id"] is None and seen()["paid_at"] is None
    assert client.get("/merchant/transactions", headers=shop["headers"]).json() == []
    rec = client.get("/merchant/reconciliation", headers=shop["headers"]).json()
    assert dec(rec["paid_total"]) == 0 and dec(rec["awaiting_total"]) == 499 and rec["mismatches"] == 0

    assert confirm(client, asha, sid, token).status_code == 200  # ... and only the confirmation settles it
    s = seen()
    assert s["status"] == "PAID" and s["transaction_id"].startswith("FP-") and s["paid_at"]
    rec = client.get("/merchant/reconciliation", headers=shop["headers"]).json()
    assert (dec(rec["requested_total"]), dec(rec["paid_total"]), dec(rec["awaiting_total"]), rec["mismatches"]) == (499, 499, 0, 0)
    assert [(r["order_reference"], r["status"], r["transaction_id"]) for r in rec["rows"]] == [("ORD-1001", "PAID", s["transaction_id"])]


def test_reconciliation_flags_a_paid_session_without_a_matching_transaction(client, world, shop, db):
    asha, _, _ = world
    sid = create_session(client, shop, amount="75.00")["session_id"]
    db.execute(PaymentSession.__table__.update().where(PaymentSession.session_id == sid).values(status="PAID"))  # a status with no money behind it
    db.commit()
    rec = client.get("/merchant/reconciliation", headers=shop["headers"]).json()
    assert rec["mismatches"] == 1 and dec(rec["paid_total"]) == 0


def test_reconciliation_and_display_are_scoped_to_the_merchant(client, world, shop):
    from tests.payment_helpers import new_merchant

    asha, _, _ = world
    other = new_merchant(client, "Corner Cafe")
    mine = create_session(client, shop, amount="100.00", ref="MINE")["session_id"]
    assert client.get("/merchant/reconciliation", headers=other["headers"]).json()["rows"] == []
    assert client.post(f"/merchant/payment-sessions/{mine}/display", json={"discoverable": True}, headers=other["headers"]).status_code == 404
    assert client.get("/merchant/reconciliation", headers=asha["headers"]).status_code == 403  # customers cannot use merchant routes


# ============================================================ the simulated nearby list


def test_nearby_lists_only_open_requests_that_merchants_chose_to_display(client, world, shop, db):
    asha, _, _ = world
    shown = create_session(client, shop, amount="120.00", ref="ON-DISPLAY", discoverable=True)["session_id"]
    create_session(client, shop, amount="130.00", ref="HIDDEN")
    r = client.get("/payments/nearby", headers=asha["headers"])
    assert r.status_code == 200
    rows = r.json()
    assert [(x["session_id"], x["merchant_name"], x["order_reference"]) for x in rows] == [(shown, "SuperGrocery", "ON-DISPLAY")]
    assert dec(rows[0]["amount"]) == 120 and rows[0]["checkout_path"] == f"/checkout/{shown}"
    assert "email" not in str(rows).lower()

    expire(db, shown)  # an expired request disappears
    assert client.get("/payments/nearby", headers=asha["headers"]).json() == []


def test_a_merchant_can_show_and_hide_a_request_and_a_paid_one_is_not_listed(client, world, shop):
    asha, _, _ = world
    sid = create_session(client, shop, amount="90.00", ref="TOGGLE")["session_id"]
    nearby = lambda: [x["session_id"] for x in client.get("/payments/nearby", headers=asha["headers"]).json()]  # noqa: E731
    assert nearby() == []
    assert client.post(f"/merchant/payment-sessions/{sid}/display", json={"discoverable": True}, headers=shop["headers"]).json()["discoverable"] is True
    assert nearby() == [sid]
    assert client.post(f"/merchant/payment-sessions/{sid}/display", json={"discoverable": False}, headers=shop["headers"]).json()["discoverable"] is False
    assert nearby() == []
    client.post(f"/merchant/payment-sessions/{sid}/display", json={"discoverable": True}, headers=shop["headers"])
    assert confirm(client, asha, sid, authorize(client, asha, sid)).status_code == 200
    assert nearby() == []
    r = client.post(f"/merchant/payment-sessions/{sid}/display", json={"discoverable": True}, headers=shop["headers"])
    assert r.status_code == 409 and code(r) == "SESSION_NOT_OPEN"


def test_nearby_is_for_customers_only(client, shop):
    assert client.get("/payments/nearby", headers=shop["headers"]).status_code == 403
    assert client.get("/payments/nearby").status_code in (401, 403)


# ============================================================ a person cannot pay without being able to name a bank


def test_a_customer_without_a_bank_is_told_to_connect_one_and_nothing_is_paid(client, world, shop, db):
    asha, _, _ = world
    assert client.delete(f"/banks/{asha['bank']['connection_id']}", headers=asha["headers"]).status_code == 200
    sid = create_session(client, shop, amount="499.00")["session_id"]
    assert checkout(client, asha, sid)["funding_sources"] == []
    r = confirm(client, asha, sid, authorize(client, asha, sid))
    assert r.status_code == 409 and code(r) == "NO_FUNDING_SOURCE"
    assert txns(db) == []


def test_the_face_check_still_works_the_same_way_for_a_wrong_person(client, world, shop, db):
    """The recognition code is unchanged: someone else's face still cannot start a payment for Asha."""
    asha, _, _ = world
    sid = create_session(client, shop, amount="499.00")["session_id"]
    r = authenticate(client, asha, sid, identity=1)  # Ravi's face on Asha's account
    assert r.status_code == 200 and r.json()["result"] != "AUTHENTICATED" and r.json()["authorization"] is None
    assert txns(db) == []
