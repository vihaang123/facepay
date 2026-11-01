"""Find a customer by face and ask them for money: opt-in, the scan ticket, mandatory purpose and reference, a shop's request
addressed to one customer, the incoming pop-up feed, approving and declining.

Real PostgreSQL. Camera frames are synthetic scenes; the recognition code behind them is the unchanged production code.
These are automated tests, not a hosted run."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.models import FaceLookup, PaymentRequest, PaymentSession, SecurityEvent, Transaction
from tests.payment_helpers import authorize, b64, confirm, enroll, new_customer
from tests.synthetic_scenes import empty_scene, scene
from tests.transfer_helpers import code

pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes


def dec(v):
    return Decimal(str(v))


def opt_in(client, cust, enabled=True):
    r = client.put("/security/face-lookup", json={"enabled": enabled}, headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def frames(identity, start_var=300, n=3, extra=None):
    return [b64(scene(identity, start_var + i, x=150 + i, extra=extra)) for i in range(n)]


def look(client, actor, identity, **kw):
    return client.post("/face-lookup", json={"frames": frames(identity, **kw)}, headers=actor["headers"])


def found(client, actor, identity, **kw):
    r = look(client, actor, identity, **kw)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["matched"] is True, body
    return body


def ask_by_face(client, requester, token, amount="250.00", purpose="GOODS", note="Order 14 groceries"):
    return client.post("/requests", json={"lookup_token": token, "amount": amount, "purpose": purpose, "note": note}, headers=requester["headers"])


def prompts(client, cust):
    r = client.get("/requests/incoming/prompts", headers=cust["headers"])
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def two(client, world):
    """Asha (face 0) and Ravi (face 1), both enrolled and in the trained model; Chitra can only receive."""
    return world


# ============================================================ opting in


def test_nobody_can_be_found_until_they_switch_it_on(client, two):
    asha, ravi, _ = two
    assert client.get("/security/overview", headers=ravi["headers"]).json()["face_lookup_enabled"] is False
    r = look(client, asha, 1)
    assert r.status_code == 200 and r.json()["matched"] is False and r.json()["reason"] == "NO_MATCH"
    assert r.json()["lookup_token"] is None and r.json()["person"] is None
    assert "Ravi" not in r.text  # a refusal never names the customer whose face it was


def test_switching_it_on_and_off_is_recorded_and_takes_effect_at_once(client, two, db):
    asha, ravi, _ = two
    assert opt_in(client, ravi)["face_lookup_enabled"] is True
    assert look(client, asha, 1).json()["matched"] is True
    assert opt_in(client, ravi, False)["face_lookup_enabled"] is False
    assert look(client, asha, 1).json()["matched"] is False
    kinds = [e.kind for e in db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == ravi["id"]).order_by(SecurityEvent.id))]
    assert "FACE_LOOKUP_ENABLED" in kinds and "FACE_LOOKUP_DISABLED" in kinds


# ============================================================ the scan


def test_a_scan_shows_a_name_and_a_masked_id_and_nothing_else(client, two, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    body = found(client, asha, 1)
    assert body["person"]["display_name"] == "Ravi Shah"
    assert "*" in body["person"]["masked_id"] and body["person"]["masked_id"].endswith("@facepay")
    assert ravi["facepay_id"] not in str(body)  # the full ID is not handed to the person scanning
    assert set(body["person"]) == {"display_name", "masked_id"}
    assert body["lookup_token"].startswith("fl_") and 0 < body["expires_in_seconds"] <= 600
    row = db.scalar(select(FaceLookup))
    assert row.token_hash != body["lookup_token"] and len(row.token_hash) == 64  # only a hash is stored
    kinds = [e.kind for e in db.scalars(select(SecurityEvent).where(SecurityEvent.user_id == ravi["id"]))]
    assert "FACE_LOOKUP_MATCH" in kinds  # the person found can see that someone scanned them


def test_scanning_your_own_face_says_so(client, two):
    asha, _, _ = two
    opt_in(client, asha)
    r = look(client, asha, 0)
    assert r.json()["matched"] is False and r.json()["reason"] == "SELF"


def test_a_stranger_is_not_matched_with_the_real_thresholds(client):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    enroll(client, a, 0)
    enroll(client, b, 1)
    assert client.post("/faces/train", headers=a["headers"]).status_code == 200
    opt_in(client, a)
    opt_in(client, b)
    watcher = new_customer(client, "Watcher")
    misses = [look(client, watcher, 9, start_var=300 + 10 * k).json()["matched"] for k in range(5)]
    assert misses == [False] * 5


def test_bad_camera_views_are_explained_and_never_match(client, two):
    asha, ravi, _ = two
    opt_in(client, ravi)
    empty = client.post("/face-lookup", json={"frames": [b64(empty_scene())] * 3}, headers=asha["headers"]).json()
    assert empty["matched"] is False and empty["reason"] == "CAMERA_NO_FACE"
    crowd = look(client, asha, 1, extra=[(0, 5, 20, 70, 96)]).json()
    assert crowd["matched"] is False and crowd["reason"] == "CAMERA_MULTIPLE_FACES"
    assert client.post("/face-lookup", json={"frames": ["!" * 20] * 2}, headers=asha["headers"]).status_code == 422  # not base64
    assert client.post("/face-lookup", json={"frames": [b64(scene(1, 1))]}, headers=asha["headers"]).status_code == 422  # one frame is too few


def test_finding_people_by_face_needs_a_trained_model(client):
    a, b = new_customer(client, "Asha Rao"), new_customer(client, "Ravi Shah")
    r = look(client, a, 1)
    assert r.status_code == 503 and code(r) == "LOOKUP_UNAVAILABLE"
    assert b["id"]


def test_only_signed_in_customers_and_shops_can_scan(client, two):
    assert client.post("/face-lookup", json={"frames": frames(1)}).status_code == 401
    assert client.post("/face-lookup", json={"frames": frames(1)}, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_scans_are_rate_limited_per_requester(client, two, monkeypatch):
    from app.api import face_lookup as api

    asha, ravi, _ = two
    monkeypatch.setattr(api.lookup_limiter, "enabled", True)
    api.lookup_limiter.reset()
    try:
        codes = [look(client, asha, 1).status_code for _ in range(api.lookup_limiter.max_requests + 2)]
    finally:
        api.lookup_limiter.reset()
    assert codes[: api.lookup_limiter.max_requests] == [200] * api.lookup_limiter.max_requests and codes[-1] == 429


# ============================================================ asking a customer for money after a scan


def test_a_customer_asks_the_person_they_scanned_and_the_ticket_is_spent(client, two, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    token = found(client, asha, 1)["lookup_token"]
    r = ask_by_face(client, asha, token)
    assert r.status_code == 201, r.text
    req = r.json()
    assert req["counterparty_name"] == "Ravi Shah" and req["source"] == "FACE" and req["purpose"] == "GOODS"
    assert req["purpose_label"] == "Goods or shopping" and req["note"] == "Order 14 groceries" and dec(req["amount"]) == 250
    assert db.scalar(select(FaceLookup)).consumed_at is not None
    again = ask_by_face(client, asha, token)
    assert again.status_code == 404 and code(again) == "LOOKUP_NOT_FOUND"  # one scan, one request
    assert db.scalar(select(func.count()).select_from(PaymentRequest)) == 1


def test_a_ticket_only_works_for_the_one_who_scanned(client, two, shop):
    asha, ravi, chitra = two
    opt_in(client, ravi)
    token = found(client, asha, 1)["lookup_token"]
    assert code(ask_by_face(client, chitra, token)) == "LOOKUP_NOT_FOUND"  # another customer
    assert client.post("/merchant/payment-sessions/by-face", headers=shop["headers"], json={
        "lookup_token": token, "amount": "10.00", "purpose": "GOODS", "order_reference": "Order 15"}).status_code == 404  # a shop
    assert ask_by_face(client, asha, token).status_code == 201  # and it was not spent by those attempts
    assert code(ask_by_face(client, asha, "fl_" + "A" * 40)) == "LOOKUP_NOT_FOUND"


def test_an_expired_ticket_is_refused(client, two, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    token = found(client, asha, 1)["lookup_token"]
    db.execute(FaceLookup.__table__.update().values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    r = ask_by_face(client, asha, token)
    assert r.status_code == 410 and code(r) == "LOOKUP_EXPIRED"


def test_a_customer_who_opted_out_after_the_scan_cannot_be_asked(client, two, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    token = found(client, asha, 1)["lookup_token"]
    opt_in(client, ravi, False)
    r = ask_by_face(client, asha, token)
    assert r.status_code == 409 and code(r) == "LOOKUP_UNAVAILABLE"
    assert db.scalar(select(func.count()).select_from(PaymentRequest)) == 0


def test_a_failed_request_does_not_spend_the_ticket(client, two):
    asha, ravi, _ = two
    opt_in(client, ravi)
    token = found(client, asha, 1)["lookup_token"]
    over = ask_by_face(client, asha, token, amount="50000.01")
    assert over.status_code == 422 and code(over) == "PER_TRANSACTION_LIMIT"
    assert ask_by_face(client, asha, token, amount="500.00").status_code == 201  # fixed the amount, same scan


# ============================================================ purpose and reference are required (anti-scam)


@pytest.mark.parametrize("override", [
    {"purpose": None}, {"note": None}, {"purpose": "GIFTS"}, {"purpose": ""},
    {"note": ""}, {"note": "  "}, {"note": "ab"}, {"note": "1234"}, {"note": "aaaa"}, {"note": "x" * 81},
    {"note": "Send OTP to claim"}, {"note": "you won a lottery"}, {"note": "gift card for tax"}, {"note": "password reset fee"},
])
def test_a_request_without_a_real_purpose_and_reference_is_refused(client, two, db, override):
    asha, ravi, _ = two
    body = {"payer_facepay_id": ravi["facepay_id"], "amount": "100.00", "purpose": "OTHER", "note": "Dinner split Friday"}
    for k, v in override.items():
        if v is None:
            body.pop(k)
        else:
            body[k] = v
    r = client.post("/requests", json=body, headers=asha["headers"])
    assert r.status_code == 422, r.text
    assert db.scalar(select(func.count()).select_from(PaymentRequest)) == 0


def test_a_request_names_the_person_one_way_only(client, two):
    asha, ravi, _ = two
    base = {"amount": "100.00", "purpose": "OTHER", "note": "Dinner split Friday"}
    assert client.post("/requests", json=base, headers=asha["headers"]).status_code == 422
    both = {**base, "payer_facepay_id": ravi["facepay_id"], "lookup_token": "fl_" + "A" * 40}
    assert client.post("/requests", json=both, headers=asha["headers"]).status_code == 422
    ok = client.post("/requests", json={**base, "payer_facepay_id": ravi["facepay_id"]}, headers=asha["headers"])
    assert ok.status_code == 201 and ok.json()["source"] == "ID" and ok.json()["purpose_label"] == "Something else"


# ============================================================ the pop-up feed


def test_the_person_asked_gets_it_in_their_incoming_feed_with_the_reason(client, two):
    asha, ravi, chitra = two
    opt_in(client, ravi)
    assert prompts(client, ravi) == []
    ask_by_face(client, asha, found(client, asha, 1)["lookup_token"], amount="250.00", purpose="BILL_SPLIT", note="Dinner at Cafe Zoe")
    [p] = prompts(client, ravi)
    assert (p["kind"], p["from_name"], p["purpose"], p["purpose_label"], p["reference"]) == ("REQUEST", "Asha Rao", "BILL_SPLIT", "Splitting a bill", "Dinner at Cafe Zoe")
    assert dec(p["amount"]) == 250 and p["ref"].startswith("pr_") and p["from_detail"].startswith(asha["facepay_id"][:1])
    assert prompts(client, asha) == [] and prompts(client, chitra) == []  # nobody else sees it, not even the sender


def test_a_declined_expired_or_paid_request_leaves_the_feed(client, two, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    ref = ask_by_face(client, asha, found(client, asha, 1)["lookup_token"]).json()["request_id"]
    assert len(prompts(client, ravi)) == 1
    assert client.post(f"/requests/{ref}/decline", headers=ravi["headers"]).status_code == 200
    assert prompts(client, ravi) == []
    ref2 = ask_by_face(client, asha, found(client, asha, 1, start_var=400)["lookup_token"]).json()["request_id"]
    db.execute(PaymentRequest.__table__.update().where(PaymentRequest.request_id == ref2).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    db.commit()
    assert prompts(client, ravi) == []


def test_the_feed_is_for_customers_only(client, two, shop):
    assert client.get("/requests/incoming/prompts").status_code == 401
    assert client.get("/requests/incoming/prompts", headers=shop["headers"]).status_code == 403


def test_approving_a_scanned_request_takes_ravis_own_face_and_confirmation(client, two, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    ref = ask_by_face(client, asha, found(client, asha, 1)["lookup_token"], amount="250.00").json()["request_id"]
    start = client.post(f"/requests/{ref}/pay", headers=ravi["headers"])
    assert start.status_code == 201, start.text
    co = start.json()
    assert co["purpose"] == "GOODS" and co["purpose_label"] == "Goods or shopping" and co["note"] == "Order 14 groceries"
    sid = co["session_id"]
    assert db.scalar(select(func.count()).select_from(Transaction)) == 0  # being asked, and even starting to pay, moves nothing
    wrong = authorize_attempt(client, ravi, sid, identity=0)  # Asha's face cannot approve Ravi's payment
    assert wrong["result"] == "REJECTED"
    token = authorize(client, ravi, sid, identity=1)
    done = confirm(client, ravi, sid, token)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "SUCCESS" and done.json()["funding_source"]["bank_name"]
    assert prompts(client, ravi) == []
    assert client.get(f"/requests/{ref}", headers=asha["headers"]).json()["status"] == "PAID"


def authorize_attempt(client, cust, sid, identity):
    from tests.payment_helpers import authenticate

    return authenticate(client, cust, sid, identity=identity).json()


# ============================================================ a shop asks the customer it scanned


def shop_asks(client, shop, token, **over):
    body = {"lookup_token": token, "amount": "480.00", "purpose": "GOODS", "order_reference": "Bill 2231 groceries"}
    body.update(over)
    return client.post("/merchant/payment-sessions/by-face", json=body, headers=shop["headers"])


def test_a_shop_scans_a_customer_and_the_request_reaches_only_that_customer(client, two, shop, db):
    asha, ravi, chitra = two
    opt_in(client, ravi)
    scan = found(client, shop, 1)
    assert scan["person"]["display_name"] == "Ravi Shah"
    r = shop_asks(client, shop, scan["lookup_token"], description="2 bags rice")
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["requested_from"] == "Ravi Shah" and s["purpose"] == "GOODS" and s["order_reference"] == "Bill 2231 groceries"
    assert s["status"] == "CREATED" and s["discoverable"] is False and dec(s["amount"]) == 480
    sid = s["session_id"]
    # only Ravi sees it
    [p] = prompts(client, ravi)
    assert (p["kind"], p["ref"], p["from_name"], p["from_detail"], p["reference"]) == ("SHOP", sid, "SuperGrocery", "Shop", "Bill 2231 groceries")
    for other in (asha, chitra):
        assert prompts(client, other) == []
        assert client.get(f"/payments/sessions/{sid}", headers=other["headers"]).status_code == 404
    assert all(n["session_id"] != sid for n in client.get("/payments/nearby", headers=asha["headers"]).json())
    assert db.scalar(select(SecurityEvent).where(SecurityEvent.user_id == ravi["id"], SecurityEvent.kind == "PAYMENT_REQUEST_RECEIVED")) is not None


def test_the_customer_approves_the_shops_request_with_their_face_and_it_is_paid_once(client, two, shop, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    sid = shop_asks(client, shop, found(client, shop, 1)["lookup_token"]).json()["session_id"]
    co = client.get(f"/payments/sessions/{sid}", headers=ravi["headers"]).json()
    assert co["merchant_name"] == "SuperGrocery" and co["purpose_label"] == "Goods or shopping" and co["order_reference"] == "Bill 2231 groceries"
    assert db.scalar(select(func.count()).select_from(Transaction)) == 0
    token = authorize(client, ravi, sid, identity=1)
    r = confirm(client, ravi, sid, token)
    assert r.status_code == 200 and r.json()["status"] == "SUCCESS", r.text
    assert confirm(client, ravi, sid, token).status_code in (400, 409)  # no second payment from the same approval
    assert db.scalar(select(func.count()).select_from(Transaction)) == 1
    paid = client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()
    assert paid["status"] == "PAID" and paid["transaction_id"] and paid["paid_at"]
    assert prompts(client, ravi) == []


def test_the_customer_can_decline_a_shops_request_and_nothing_is_paid(client, two, shop, db):
    asha, ravi, _ = two
    opt_in(client, ravi)
    sid = shop_asks(client, shop, found(client, shop, 1)["lookup_token"]).json()["session_id"]
    assert client.post(f"/payments/sessions/{sid}/decline", headers=asha["headers"]).status_code == 404  # not hers to decline
    r = client.post(f"/payments/sessions/{sid}/decline", headers=ravi["headers"])
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"
    assert client.get(f"/merchant/payment-sessions/{sid}", headers=shop["headers"]).json()["status"] == "CANCELLED"
    assert prompts(client, ravi) == []
    assert client.post(f"/payments/sessions/{sid}/decline", headers=ravi["headers"]).status_code == 409  # already closed
    assert db.scalar(select(func.count()).select_from(Transaction)) == 0
    token_try = client.post(f"/payments/sessions/{sid}/authenticate/start", headers=ravi["headers"])
    assert token_try.status_code >= 400  # a closed request cannot be paid


def test_a_bill_for_anyone_cannot_be_declined_away_by_a_customer(client, two, shop):
    asha, _, _ = two
    sid = client.post("/merchant/payment-sessions", json={"amount": "100.00", "order_reference": "SG-1"}, headers=shop["headers"]).json()["session_id"]
    assert client.post(f"/payments/sessions/{sid}/decline", headers=asha["headers"]).status_code == 404


@pytest.mark.parametrize("override", [{"purpose": None}, {"order_reference": None}, {"purpose": "NOPE"}, {"order_reference": "ab"}, {"order_reference": "Send OTP now"}, {"amount": "0"}])
def test_a_shops_request_needs_a_real_purpose_and_reference(client, two, shop, db, override):
    asha, ravi, _ = two
    opt_in(client, ravi)
    token = found(client, shop, 1)["lookup_token"]
    body = {"lookup_token": token, "amount": "480.00", "purpose": "GOODS", "order_reference": "Bill 2231 groceries"}
    for k, v in override.items():
        body.pop(k) if v is None else body.__setitem__(k, v)
    r = client.post("/merchant/payment-sessions/by-face", json=body, headers=shop["headers"])
    assert r.status_code == 422, r.text
    assert db.scalar(select(func.count()).select_from(PaymentSession)) == 0
    assert shop_asks(client, shop, token).status_code == 201  # a rejected attempt does not spend the scan


def test_a_customer_cannot_use_the_shop_route_and_a_shop_cannot_use_the_customer_one(client, two, shop):
    asha, ravi, _ = two
    opt_in(client, ravi)
    token = found(client, asha, 1)["lookup_token"]
    body = {"lookup_token": token, "amount": "10.00", "purpose": "GOODS", "order_reference": "Order 15"}
    assert client.post("/merchant/payment-sessions/by-face", json=body, headers=asha["headers"]).status_code == 403
    assert client.post("/requests", json={"lookup_token": token, "amount": "10.00", "purpose": "GOODS", "note": "Order 15"}, headers=shop["headers"]).status_code == 403


def test_a_disabled_account_cannot_be_found_or_scan(client, two, db):
    from app.models import User

    asha, ravi, _ = two
    opt_in(client, ravi)
    db.execute(User.__table__.update().where(User.id == ravi["id"]).values(status="disabled"))
    db.commit()
    assert look(client, asha, 1).json()["matched"] is False
    assert look(client, ravi, 0).status_code == 403
