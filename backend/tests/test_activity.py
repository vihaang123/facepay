"""The customer's history: assembled from real records, scoped to the signed-in customer, filterable and searchable."""

from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import PaymentSession
from tests.payment_helpers import authorize, confirm, create_session
from tests.transfer_helpers import pay_transfer, prepared

from tests.test_requests import asked


pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes


@pytest.fixture
def busy(client, world, shop, db):
    """Asha pays Ravi, Ravi pays Asha, Asha pays a shop; Asha has a pending request to Ravi, Ravi's request to Asha was
    declined, one of Asha's payments was cancelled, and one merchant bill failed after face checks."""
    asha, ravi, chitra = world
    sent = pay_transfer(client, asha, ravi, "100.00", note="Cab fare").json()
    got = pay_transfer(client, ravi, asha, "40.00", note="Coffee", identity=1).json()
    bill = create_session(client, shop, amount="250.00", ref="SG-5")["session_id"]
    shop_txn = confirm(client, asha, bill, authorize(client, asha, bill)).json()
    pending = asked(client, asha, ravi, "75.00", "Movie")
    declined = asked(client, ravi, asha, "20.00", "Lunch")
    assert client.post(f"/requests/{declined}/decline", headers=asha["headers"]).status_code == 200
    cancelled = prepared(client, asha, chitra, "15.00", "Oops")
    assert client.post(f"/transfers/{cancelled}/cancel", headers=asha["headers"]).status_code == 200
    failed = create_session(client, shop, amount="60.00", ref="SG-6")["session_id"]
    from tests.payment_helpers import authenticate

    for _ in range(5):
        authenticate(client, asha, failed, identity=1)  # the wrong face five times closes the bill
    db.expire_all()
    assert db.scalar(select(PaymentSession.status).where(PaymentSession.session_id == failed)) == "FAILED"
    return {"asha": asha, "ravi": ravi, "chitra": chitra, "sent": sent, "got": got, "shop": shop_txn, "pending": pending, "declined": declined, "cancelled": cancelled, "failed": failed}


def items(client, who, **params):
    r = client.get("/activity", params=params, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def refs(client, who, **params):
    return [i["ref"] for i in items(client, who, **params)]


def test_each_filter_shows_the_right_records(client, busy):
    a, r = busy["asha"], busy["ravi"]
    sent, got, shop_txn = busy["sent"]["transaction_id"], busy["got"]["transaction_id"], busy["shop"]["transaction_id"]
    assert set(refs(client, a)) == {sent, got, shop_txn, busy["pending"], busy["declined"], busy["cancelled"], busy["failed"]}
    assert set(refs(client, a, filter="sent")) == {sent, shop_txn}
    assert set(refs(client, a, filter="received")) == {got}
    assert set(refs(client, a, filter="successful")) == {sent, got, shop_txn}
    assert set(refs(client, a, filter="failed")) == {busy["failed"]}
    assert set(refs(client, a, filter="pending")) == {busy["pending"], busy["declined"]} - {busy["declined"]}
    assert set(refs(client, a, filter="cancelled")) == {busy["declined"], busy["cancelled"]}
    # Ravi sees his own side only
    assert set(refs(client, r)) == {sent, got, busy["pending"], busy["declined"]}
    assert set(refs(client, r, filter="received")) == {sent} and set(refs(client, r, filter="sent")) == {got}


def test_directions_statuses_and_counterparties_are_from_the_viewers_side(client, busy):
    by = {i["ref"]: i for i in items(client, busy["asha"])}
    sent, got, shop_txn = by[busy["sent"]["transaction_id"]], by[busy["got"]["transaction_id"]], by[busy["shop"]["transaction_id"]]
    assert (sent["direction"], sent["counterparty_name"], sent["note"], sent["kind"]) == ("SENT", "Ravi Shah", "Cab fare", "TRANSFER")
    assert (got["direction"], got["counterparty_name"], got["note"]) == ("RECEIVED", "Ravi Shah", "Coffee")
    assert (shop_txn["direction"], shop_txn["counterparty_name"], shop_txn["kind"], shop_txn["order_reference"]) == ("SENT", "SuperGrocery", "MERCHANT_PAYMENT", "SG-5")
    assert (by[busy["pending"]]["direction"], by[busy["pending"]]["status"]) == ("REQUESTED", "PENDING")
    assert (by[busy["declined"]]["direction"], by[busy["declined"]]["status"]) == ("REQUEST_RECEIVED", "DECLINED")
    assert by[busy["cancelled"]]["status"] == "CANCELLED" and by[busy["failed"]]["status"] == "FAILED"
    ravi_view = {i["ref"]: i for i in items(client, busy["ravi"])}
    assert ravi_view[busy["pending"]]["direction"] == "REQUEST_RECEIVED" and ravi_view[busy["sent"]["transaction_id"]]["direction"] == "RECEIVED"
    for i in by.values():
        assert "email" not in str(i).lower() and i["currency"] == "INR"
        assert i["counterparty_masked_id"] is None or "***" in i["counterparty_masked_id"] or len(i["counterparty_masked_id"]) < 14


def test_search_matches_reference_name_note_and_order(client, busy):
    a = busy["asha"]
    assert refs(client, a, q="Cab") == [busy["sent"]["transaction_id"]]
    assert refs(client, a, q="ravi", filter="sent") == [busy["sent"]["transaction_id"]]
    assert refs(client, a, q=busy["got"]["transaction_id"][3:9].lower()) == [busy["got"]["transaction_id"]]
    assert refs(client, a, q="SG-5") == [busy["shop"]["transaction_id"]]
    assert refs(client, a, q="superg") and refs(client, a, q="Movie") == [busy["pending"]]
    assert refs(client, a, q="no such thing") == []
    assert refs(client, a, q="100%") == [] and refs(client, a, q="%") == []  # LIKE wildcards in the search are plain text


def test_pagination_walks_the_whole_history_in_order(client, busy):
    a = busy["asha"]
    everything = refs(client, a, limit=51)
    pages = refs(client, a, limit=3, offset=0) + refs(client, a, limit=3, offset=3) + refs(client, a, limit=3, offset=6)
    assert pages == everything and len(set(everything)) == len(everything) == 7
    stamps = [i["timestamp"] for i in items(client, a, limit=51)]
    assert stamps == sorted(stamps, reverse=True)
    assert client.get("/activity", params={"limit": 0}, headers=a["headers"]).status_code == 422
    assert client.get("/activity", params={"limit": 200}, headers=a["headers"]).status_code == 422
    assert client.get("/activity", params={"offset": 99999}, headers=a["headers"]).status_code == 422
    assert client.get("/activity", params={"filter": "everything"}, headers=a["headers"]).status_code == 422


def test_another_customers_history_is_unreachable(client, busy):
    chitra = busy["chitra"]
    assert items(client, chitra) == []
    for ref in (busy["sent"]["transaction_id"], busy["pending"], busy["failed"], busy["cancelled"]):
        r = client.get(f"/activity/{ref}", headers=chitra["headers"])
        assert r.status_code == 404, ref
    assert client.get(f"/payments/transactions/{busy['sent']['transaction_id']}", headers=chitra["headers"]).status_code == 404
    assert client.get("/payments/transactions", headers=chitra["headers"]).json() == []
    # nothing in the query string can widen the scope
    assert items(client, chitra, q=busy["sent"]["transaction_id"]) == []
    assert client.get("/activity", params={"user_id": busy["asha"]["id"]}, headers=chitra["headers"]).json() == []


def test_a_transaction_detail_has_everything_the_page_needs(client, busy):
    d = client.get(f"/activity/{busy['sent']['transaction_id']}", headers=busy["asha"]["headers"]).json()
    assert d["ref"] == busy["sent"]["transaction_id"] and d["status"] == "SUCCESS" and Decimal(d["amount"]) == 100 and d["currency"] == "INR"
    assert (d["sender_name"], d["recipient_name"], d["note"], d["payment_method"]) == ("Asha Rao", "Ravi Shah", "Cab fare", "FacePay (simulated)")
    assert d["authentication"] == "Face + basic liveness check" and d["timestamp"] and d["direction"] == "SENT"
    assert "***" in d["sender_masked_id"] and "***" in d["recipient_masked_id"]
    theirs = client.get(f"/activity/{busy['sent']['transaction_id']}", headers=busy["ravi"]["headers"]).json()
    assert theirs["direction"] == "RECEIVED" and theirs["sender_name"] == "Asha Rao"


def test_request_and_failed_payment_details(client, busy):
    req = client.get(f"/activity/{busy['pending']}", headers=busy["ravi"]["headers"]).json()
    assert req["kind"] == "REQUEST" and req["status"] == "PENDING" and req["authentication"] == "Not paid yet"
    assert (req["sender_name"], req["recipient_name"]) == ("Ravi Shah", "Asha Rao")  # Ravi would be the one paying
    failed = client.get(f"/activity/{busy['failed']}", headers=busy["asha"]["headers"]).json()
    assert failed["status"] == "FAILED" and failed["authentication"] == "Payment not completed"
    assert client.get("/activity/FP-DOESNOTEXIST", headers=busy["asha"]["headers"]).status_code == 404
    assert client.get("/activity/zzz", headers=busy["asha"]["headers"]).status_code == 404


def test_a_merchant_never_sees_the_customer_to_customer_receipt(client, busy, shop):
    t = busy["sent"]["transaction_id"]
    assert client.get(f"/merchant/transactions/{t}", headers=shop["headers"]).status_code == 404
    mine = client.get("/merchant/transactions", headers=shop["headers"]).json()
    assert [m["transaction_id"] for m in mine] == [busy["shop"]["transaction_id"]]
    assert all("Ravi" not in str(m) for m in mine)


def test_history_is_empty_but_valid_for_a_new_customer(client, world):
    _, _, chitra = world
    assert items(client, chitra) == [] and client.get("/requests", headers=chitra["headers"]).json() == []
    assert client.get("/facepay/contacts", headers=chitra["headers"]).json() == []
    w = client.get("/wallet", headers=chitra["headers"]).json()
    assert Decimal(w["balance"]) == 10000 and len(w["entries"]) == 1


def test_pending_requests_count_drops_when_they_are_settled(client, world):
    asha, ravi, _ = world
    r1, r2 = asked(client, asha, ravi, "1.00"), asked(client, asha, ravi, "2.00")
    count = lambda: client.get("/activity/counts", headers=ravi["headers"]).json()["pending_incoming_requests"]  # noqa: E731
    assert count() == 2
    client.post(f"/requests/{r1}/decline", headers=ravi["headers"])
    assert count() == 1
    client.post(f"/requests/{r2}/cancel", headers=asha["headers"])
    assert count() == 0
