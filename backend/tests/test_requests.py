"""Request money: a request moves nothing. The asked customer opens it, reviews it, and pays it through the same face
verification, single-use authorization and explicit confirmation as any other payment. States are enforced on the server."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, update

from app.models import PaymentAuthorization, PaymentRequest, PaymentSession, Transaction
from app.services import request_service
from tests.payment_helpers import authorize, confirm
from tests.transfer_helpers import balance, code

pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes


OPENING = Decimal("10000")


def dec(v):
    return Decimal(str(v))


def ask(client, requester, payer, amount="600.00", note=None):
    body = {"payer_facepay_id": payer["facepay_id"], "amount": amount}
    if note is not None:
        body["note"] = note
    return client.post("/requests", json=body, headers=requester["headers"])


def asked(client, requester, payer, amount="600.00", note=None):
    r = ask(client, requester, payer, amount, note)
    assert r.status_code == 201, r.text
    return r.json()["request_id"]


def start_paying(client, payer, ref, key=None):
    headers = dict(payer["headers"])
    if key:
        headers["Idempotency-Key"] = key
    return client.post(f"/requests/{ref}/pay", headers=headers)


def request_row(db, ref):
    db.expire_all()
    return db.scalar(select(PaymentRequest).where(PaymentRequest.request_id == ref))


# ============================================================ creating a request


def test_a_request_moves_no_money_and_waits_for_the_payer(client, world, db):
    asha, ravi, _ = world
    r = ask(client, asha, ravi, "600.00", "Share of the cab")
    assert r.status_code == 201
    out = r.json()
    assert out["status"] == "PENDING" and out["direction"] == "OUTGOING" and dec(out["amount"]) == 600
    assert out["counterparty_name"] == "Ravi Shah" and out["payable"] is False  # the sender cannot pay their own request
    assert out["qr_payload"] == f"facepay://request/{out['request_id']}"
    assert dec(balance(client, asha)) == OPENING and dec(balance(client, ravi)) == OPENING
    assert db.scalar(select(func.count()).select_from(Transaction)) == 0

    seen = client.get(f"/requests/{out['request_id']}", headers=ravi["headers"]).json()
    assert seen["direction"] == "INCOMING" and seen["payable"] is True and seen["counterparty_name"] == "Asha Rao"
    assert [i["request_id"] for i in client.get("/requests", params={"box": "incoming"}, headers=ravi["headers"]).json()] == [out["request_id"]]
    assert client.get("/requests", params={"box": "incoming"}, headers=asha["headers"]).json() == []
    assert client.get("/activity/counts", headers=ravi["headers"]).json() == {"pending_incoming_requests": 1}
    assert client.get("/activity/counts", headers=asha["headers"]).json() == {"pending_incoming_requests": 0}


def test_asking_an_unknown_person_yourself_or_for_a_bad_amount_is_refused(client, world, db):
    asha, ravi, _ = world
    assert client.post("/requests", json={"payer_facepay_id": "ghost.user", "amount": "5"}, headers=asha["headers"]).status_code == 404
    r = ask(client, asha, asha)
    assert r.status_code == 422 and code(r) == "SELF_REQUEST"
    for amount in ("0", "-1", "1.005", "abc", None, "1000001"):
        assert client.post("/requests", json={"payer_facepay_id": ravi["facepay_id"], "amount": amount}, headers=asha["headers"]).status_code == 422
    big = ask(client, asha, ravi, "50000.01")
    assert big.status_code == 422 and code(big) == "PER_TRANSACTION_LIMIT"
    assert db.scalar(select(func.count()).select_from(PaymentRequest)) == 0


def test_a_requester_cannot_flood_one_person(client, world):
    asha, ravi, _ = world
    for _ in range(request_service.MAX_PENDING_PER_PAIR):
        assert ask(client, asha, ravi, "10.00").status_code == 201
    r = ask(client, asha, ravi, "10.00")
    assert r.status_code == 429 and code(r) == "TOO_MANY_PENDING_REQUESTS"


def test_requests_cannot_be_created_on_someone_elses_behalf(client, world):
    asha, ravi, chitra = world
    r = client.post("/requests", json={"payer_facepay_id": ravi["facepay_id"], "amount": "5", "requester_id": chitra["id"]}, headers=asha["headers"])
    assert r.status_code == 422


# ============================================================ privacy of requests


def test_a_request_is_visible_only_to_its_two_people(client, world):
    asha, ravi, chitra = world
    ref = asked(client, asha, ravi)
    assert client.get(f"/requests/{ref}", headers=chitra["headers"]).status_code == 404
    assert client.get("/requests", headers=chitra["headers"]).json() == []
    for action in ("pay", "decline", "cancel"):
        assert client.post(f"/requests/{ref}/{action}", headers=chitra["headers"]).status_code == 404
    assert client.get(f"/activity/{ref}", headers=chitra["headers"]).status_code == 404
    r = client.post("/facepay/qr/resolve", json={"payload": f"facepay://request/{ref}"}, headers=chitra["headers"])
    assert r.status_code == 404 and code(r) == "REQUEST_NOT_FOUND"


def test_scanning_a_request_code_shows_the_request_to_the_payer_only(client, world):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi, "600.00", "Cab")
    r = client.post("/facepay/qr/resolve", json={"payload": f"facepay://request/{ref}"}, headers=ravi["headers"])
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "REQUEST" and body["recipient"] is None and body["request"]["request_id"] == ref
    assert body["request"]["payable"] is True and dec(body["request"]["amount"]) == 600
    assert dec(balance(client, ravi)) == OPENING  # scanning charged nothing


# ============================================================ paying a request


def test_the_asked_customer_pays_a_request_with_their_own_face_and_confirmation(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi, "600.00", "Cab")
    start = start_paying(client, ravi, ref)
    assert start.status_code == 201
    checkout = start.json()
    # the amount, recipient and note come from the stored request: the payer never types them
    assert checkout["kind"] == "TRANSFER" and dec(checkout["amount"]) == 600 and checkout["recipient_name"] == "Asha Rao"
    assert checkout["recipient_facepay_id"] == asha["facepay_id"] and checkout["note"] == "Cab" and checkout["request_id"] == ref
    assert dec(balance(client, ravi)) == OPENING and request_row(db, ref).status == "PENDING"  # starting to pay debits nothing

    sid = checkout["session_id"]
    token = authorize(client, ravi, sid, identity=1)
    assert request_row(db, ref).status == "PENDING"  # a face check does not pay it either
    r = confirm(client, ravi, sid, token)
    assert r.status_code == 200 and r.json()["request_id"] == ref and r.json()["kind"] == "TRANSFER"

    row = request_row(db, ref)
    txn = db.scalar(select(Transaction).where(Transaction.id == row.transaction_id))
    assert row.status == "PAID" and row.resolved_at is not None and txn.payer_id == ravi["id"] and txn.recipient_id == asha["id"]
    assert dec(balance(client, ravi)) == OPENING - 600 and dec(balance(client, asha)) == OPENING + 600
    assert client.get(f"/requests/{ref}", headers=asha["headers"]).json()["transaction_id"] == txn.transaction_id
    # the paid request is shown once, as its transaction
    refs = [i["ref"] for i in client.get("/activity", headers=ravi["headers"]).json()]
    assert refs == [txn.transaction_id]


def test_only_the_designated_payer_can_pay(client, world):
    asha, ravi, chitra = world
    ref = asked(client, asha, ravi)
    assert start_paying(client, asha, ref).status_code == 404  # the sender
    assert start_paying(client, chitra, ref).status_code == 404  # a stranger


def test_paying_twice_is_impossible(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi, "600.00")
    sid = start_paying(client, ravi, ref).json()["session_id"]
    token = authorize(client, ravi, sid, identity=1)
    assert confirm(client, ravi, sid, token).status_code == 200
    again = start_paying(client, ravi, ref)
    assert again.status_code == 409 and code(again) == "REQUEST_NOT_PENDING"
    assert confirm(client, ravi, sid, token).status_code in (403, 409)
    assert dec(balance(client, ravi)) == OPENING - 600 and db.scalar(select(func.count()).select_from(Transaction)) == 1


def test_starting_twice_reopens_the_same_payment(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    first = start_paying(client, ravi, ref).json()["session_id"]
    second = start_paying(client, ravi, ref).json()["session_id"]
    assert first == second and db.scalar(select(func.count()).select_from(PaymentSession)) == 1


def test_simultaneous_starts_still_make_one_payment(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(lambda _: start_paying(client, ravi, ref), range(5)))
    assert {r.status_code for r in results} <= {201, 409}
    assert db.scalar(select(func.count()).select_from(PaymentSession)) == 1


def test_a_request_cannot_be_paid_without_enough_balance(client, world, db):
    asha, ravi, _ = world
    from tests.transfer_helpers import pay_transfer

    assert pay_transfer(client, ravi, asha, "9500.00", identity=1).status_code == 200  # Ravi now has ₹500
    ref = asked(client, asha, ravi, "600.00")
    r = start_paying(client, ravi, ref)
    assert r.status_code == 409 and code(r) == "INSUFFICIENT_BALANCE"
    assert request_row(db, ref).status == "PENDING" and dec(balance(client, ravi)) == 500


def test_a_request_cannot_be_paid_a_different_amount(client, world):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi, "600.00")
    checkout = client.post(f"/requests/{ref}/pay", json={"amount": "1.00", "recipient_facepay_id": "someone.else"}, headers=ravi["headers"])
    assert checkout.status_code == 201 and dec(checkout.json()["amount"]) == 600 and checkout.json()["recipient_facepay_id"] == asha["facepay_id"]
    sid = checkout.json()["session_id"]
    token = authorize(client, ravi, sid, identity=1)
    r = confirm(client, ravi, sid, token, expected_amount="60.00")
    assert r.status_code == 409 and code(r) == "AMOUNT_MISMATCH"


# ============================================================ declining and cancelling


def test_the_payer_can_decline_and_it_is_final(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    r = client.post(f"/requests/{ref}/decline", headers=ravi["headers"])
    assert r.status_code == 200 and r.json()["status"] == "DECLINED"
    for action in ("decline", "cancel"):
        again = client.post(f"/requests/{ref}/{action}", headers=asha["headers"] if action == "cancel" else ravi["headers"])
        assert again.status_code == 409 and code(again) == "REQUEST_NOT_PENDING"
    pay = start_paying(client, ravi, ref)
    assert pay.status_code == 409 and code(pay) == "REQUEST_NOT_PENDING"
    assert dec(balance(client, ravi)) == OPENING


def test_the_sender_can_cancel_and_the_payer_cannot_cancel_or_the_sender_decline(client, world):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    assert client.post(f"/requests/{ref}/cancel", headers=ravi["headers"]).status_code == 403
    assert client.post(f"/requests/{ref}/decline", headers=asha["headers"]).status_code == 403
    assert client.get(f"/requests/{ref}", headers=ravi["headers"]).json()["status"] == "PENDING"
    r = client.post(f"/requests/{ref}/cancel", headers=asha["headers"])
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"


def test_cancelling_while_the_payer_is_mid_payment_kills_the_payment(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi, "600.00")
    sid = start_paying(client, ravi, ref).json()["session_id"]
    token = authorize(client, ravi, sid, identity=1)
    assert client.post(f"/requests/{ref}/cancel", headers=asha["headers"]).status_code == 200
    r = confirm(client, ravi, sid, token)
    assert r.status_code == 409 and code(r) in ("SESSION_CANCELLED", "REQUEST_NOT_PENDING")
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Transaction)) == 0
    assert dec(balance(client, ravi)) == OPENING and dec(balance(client, asha)) == OPENING
    assert db.scalar(select(PaymentAuthorization.status)) == "REVOKED"
    assert db.scalar(select(PaymentSession.status)) == "CANCELLED"


def test_declining_while_mid_payment_also_stops_it(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    sid = start_paying(client, ravi, ref).json()["session_id"]
    token = authorize(client, ravi, sid, identity=1)
    assert client.post(f"/requests/{ref}/decline", headers=ravi["headers"]).status_code == 200
    assert confirm(client, ravi, sid, token).status_code == 409
    assert dec(balance(client, ravi)) == OPENING


# ============================================================ expiry and the state machine


def test_an_unpaid_request_expires(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    db.execute(update(PaymentRequest).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    db.commit()
    seen = client.get(f"/requests/{ref}", headers=ravi["headers"]).json()
    assert seen["status"] == "EXPIRED" and seen["payable"] is False
    pay = start_paying(client, ravi, ref)
    assert pay.status_code == 409 and code(pay) == "REQUEST_NOT_PENDING"
    assert client.post(f"/requests/{ref}/cancel", headers=asha["headers"]).status_code == 409
    filtered = client.get("/activity", params={"filter": "cancelled"}, headers=asha["headers"]).json()
    assert [(i["ref"], i["status"]) for i in filtered] == [(ref, "EXPIRED")]


def test_expiry_while_the_payer_is_mid_payment_blocks_the_confirmation(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    sid = start_paying(client, ravi, ref).json()["session_id"]
    token = authorize(client, ravi, sid, identity=1)
    db.execute(update(PaymentRequest).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    db.commit()
    r = confirm(client, ravi, sid, token)
    assert r.status_code == 409 and dec(balance(client, ravi)) == OPENING and db.scalar(select(func.count()).select_from(Transaction)) == 0


def test_a_payment_started_on_a_request_never_outlives_the_request(client, world, db):
    asha, ravi, _ = world
    ref = asked(client, asha, ravi)
    sid = start_paying(client, ravi, ref).json()["session_id"]
    db.expire_all()
    session_expiry = db.scalar(select(PaymentSession.expires_at).where(PaymentSession.session_id == sid))
    assert session_expiry <= request_row(db, ref).expires_at


@pytest.mark.parametrize("final", ["PAID", "DECLINED", "CANCELLED", "EXPIRED"])
@pytest.mark.parametrize("target", ["PENDING", "PAID", "DECLINED", "CANCELLED", "EXPIRED"])
def test_final_states_have_no_exit(final, target):
    from fastapi import HTTPException

    req = PaymentRequest(status=final)
    with pytest.raises(HTTPException) as e:
        request_service.transition(req, target)
    assert e.value.status_code == 409 and e.value.detail["code"] == "REQUEST_NOT_PENDING" and req.status == final


@pytest.mark.parametrize("target", ["PAID", "DECLINED", "CANCELLED", "EXPIRED"])
def test_pending_can_move_to_each_final_state_and_nowhere_else(target):
    req = PaymentRequest(status="PENDING")
    request_service.transition(req, target)
    assert req.status == target and req.resolved_at is not None
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        request_service.transition(PaymentRequest(status="PENDING"), "PENDING")
    assert e.value.status_code == 409


def test_the_database_refuses_an_unknown_request_status_or_a_self_request(client, world, db):
    asha, ravi, _ = world
    from sqlalchemy.exc import IntegrityError

    for kwargs in ({"requester_id": asha["id"], "payer_id": ravi["id"], "status": "REFUNDED"}, {"requester_id": asha["id"], "payer_id": asha["id"], "status": "PENDING"}):
        db.add(PaymentRequest(request_id="pr_x", amount=Decimal("5"), expires_at=datetime.now(UTC) + timedelta(days=1), **kwargs))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


# ============================================================ listing


def test_listing_filters_by_box_and_status_and_paginates(client, world):
    asha, ravi, chitra = world
    r1 = asked(client, asha, ravi, "1.00")
    r2 = asked(client, asha, ravi, "2.00")
    r3 = asked(client, ravi, asha, "3.00")
    client.post(f"/requests/{r2}/cancel", headers=asha["headers"])
    ids = lambda **p: [i["request_id"] for i in client.get("/requests", params=p, headers=asha["headers"]).json()]  # noqa: E731
    assert ids(box="outgoing") == [r2, r1] and ids(box="incoming") == [r3] and set(ids()) == {r1, r2, r3}
    assert ids(box="outgoing", status="CANCELLED") == [r2] and ids(box="outgoing", status="PENDING") == [r1]
    assert ids(limit=1) == [r3] and ids(limit=1, offset=1) == [r2]
    assert client.get("/requests", params={"box": "sideways"}, headers=asha["headers"]).status_code == 422
    assert client.get("/requests", params={"status": "REFUNDED"}, headers=asha["headers"]).status_code == 422
    assert client.get("/requests", headers=chitra["headers"]).json() == []


def test_requests_need_a_customer_session(client, world):
    asha, _, _ = world
    from tests.payment_helpers import new_merchant

    merchant = new_merchant(client)
    for call in (lambda h: client.get("/requests", headers=h), lambda h: client.post("/requests", json={}, headers=h)):
        assert call({}).status_code == 401
        assert call(merchant["headers"]).status_code == 403
