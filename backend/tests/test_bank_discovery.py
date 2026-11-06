"""Automatic bank account discovery (simulated): the customer picks a bank, the provider returns the account."""

import os
import re

import pytest
from sqlalchemy import select, text

from app.core.config import get_settings
from app.models import BankConnection
from app.services import bank_discovery as bd
from tests.payment_helpers import new_customer


@pytest.fixture
def swap_provider():
    """Installs a fake provider under the configured name and always puts the simulator back."""
    original = bd._PROVIDERS["simulated"]

    def install(provider):
        bd.register_provider("simulated", provider)
        return provider

    yield install
    bd._PROVIDERS["simulated"] = original


class Fake:
    name = "FAKE"

    def __init__(self, result=None, error=None):
        self.result, self.error, self.seen = result, error, []

    def discover(self, request):
        self.seen.append(request)
        if self.error:
            raise self.error
        return self.result


def link(client, cust, bank="hdfc"):
    return client.post("/banks", json={"bank_code": bank}, headers=cust["headers"])


# ---- what the customer sees ------------------------------------------------------------------------------------------------


def test_linking_returns_the_whole_account_profile_without_the_customer_entering_any_of_it(client, db):
    c = new_customer(client, "Neha  Kapoor", bank=False)
    r = link(client, c)
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["bank_name"] == "HDFC Bank"
    assert b["holder_name"] == "NEHA KAPOOR"  # the record's name, capitals, spaces tidied
    assert b["account_type"] in ("SAVINGS", "SALARY") and b["account_type_label"]
    assert re.fullmatch(r"DEMO-••••-\d{4}", b["account_ref"])
    assert re.fullmatch(r"DEMO0\d{6}", b["ifsc"]) and b["branch"].startswith("Demo Branch")
    assert b["link_status"] == "LINKED" and b["link_status_label"] == "Linked (simulated)" and b["is_default"] is True
    assert b["discovery_source"] == "SIMULATED"
    assert "No real bank account is accessed" in b["disclaimer"]


def test_a_second_account_is_not_the_default(client):
    c = new_customer(client, "Neha Kapoor", bank=False)
    assert link(client, c, "hdfc").json()["is_default"] is True
    assert link(client, c, "sbi").json()["is_default"] is False


def test_the_details_are_stored_and_listed_with_the_link(client, db):
    c = new_customer(client, "Neha Kapoor", bank=False)
    made = link(client, c).json()
    row = db.scalar(select(BankConnection))
    assert (row.holder_name, row.ifsc, row.branch, row.discovery_source) == (made["holder_name"], made["ifsc"], made["branch"], "SIMULATED")
    listed = client.get("/banks", headers=c["headers"]).json()
    assert listed == [made]


# ---- consistent across logins, restarts and re-links -------------------------------------------------------------------------


def test_the_same_details_come_back_after_logout_and_login(client):
    from tests.conftest import STRONG_PASSWORD

    c = new_customer(client, "Neha Kapoor", bank=False)
    made = link(client, c).json()
    again = client.post("/auth/login", json={"email": c["email"], "password": STRONG_PASSWORD}).json()["access_token"]
    listed = client.get("/banks", headers={"Authorization": f"Bearer {again}"}).json()
    assert listed == [made]


def test_relinking_after_disconnect_gives_the_same_account(client):
    c = new_customer(client, "Neha Kapoor", bank=False)
    first = link(client, c).json()
    assert client.delete(f"/banks/{first['connection_id']}", headers=c["headers"]).status_code == 200
    second = link(client, c).json()
    keys = ("holder_name", "account_type", "account_ref", "ifsc", "branch", "bank_name")
    assert {k: second[k] for k in keys} == {k: first[k] for k in keys}
    assert second["connection_id"] != first["connection_id"]


def test_a_restart_changes_nothing_because_the_record_is_computed_not_random():
    """A fresh provider object stands in for a restarted server."""
    req = bd.DiscoveryRequest(user_id=7, bank_code="sbi", bank_name="State Bank of India", mobile=None, customer_name="Asha Rao")
    a = bd.SimulatedDiscoveryProvider().discover(req)
    b = bd.SimulatedDiscoveryProvider().discover(req)
    assert a == b and len(a) == 1


def test_different_customers_and_different_banks_get_different_records():
    mk = lambda uid, bank: bd.SimulatedDiscoveryProvider().discover(  # noqa: E731
        bd.DiscoveryRequest(user_id=uid, bank_code=bank, bank_name=bank, mobile=None, customer_name="Asha Rao"))[0]
    assert mk(1, "sbi").ifsc != mk(2, "sbi").ifsc
    assert mk(1, "sbi").ifsc != mk(1, "hdfc").ifsc
    ids = {mk(uid, "sbi").account_last4 for uid in range(1, 40)}
    assert len(ids) > 20  # spread out, not constant


def test_a_later_name_change_does_not_rewrite_the_linked_record(client):
    c = new_customer(client, "Neha Kapoor", bank=False)
    made = link(client, c).json()
    assert client.patch("/users/me", json={"name": "Someone Else"}, headers=c["headers"]).status_code == 200
    assert client.get("/banks", headers=c["headers"]).json()[0]["holder_name"] == made["holder_name"] == "NEHA KAPOOR"


# ---- only the server decides the details; no credentials ---------------------------------------------------------------------


@pytest.mark.parametrize("extra", [
    {"holder_name": "Someone Else"}, {"ifsc": "HDFC0000001"}, {"branch": "Real Branch"}, {"account_number": "123456789012"},
    {"account_type": "CURRENT"}, {"upi_pin": "1234"}, {"card_number": "4111111111111111"}, {"aadhaar": "123412341234"}, {"otp": "123456"},
])
def test_the_client_cannot_supply_any_account_detail_or_credential(client, db, extra):
    c = new_customer(client, "Neha Kapoor", bank=False)
    assert client.post("/banks", json={"bank_code": "hdfc", **extra}, headers=c["headers"]).status_code == 422
    assert db.scalar(text("select count(*) from bank_connections")) == 0


def test_the_provider_is_given_the_bank_the_name_and_the_number_and_nothing_secret(client, swap_provider):
    fake = swap_provider(Fake([bd.DiscoveredAccount("A B", "SAVINGS", "4321")]))
    c = new_customer(client, "Neha Kapoor", bank=False)
    link(client, c)
    req = fake.seen[0]
    assert set(vars(req)) == {"user_id", "bank_code", "bank_name", "mobile", "customer_name"}
    assert req.bank_code == "hdfc" and req.bank_name == "HDFC Bank" and req.customer_name == "Neha Kapoor" and req.user_id == c["id"]


def test_the_customers_verified_number_reaches_the_provider(client, swap_provider):
    from tests.test_number_auth import signup

    fake = swap_provider(Fake([bd.DiscoveredAccount("A B", "SAVINGS", "4321")]))
    token = signup(client).json()["access_token"]
    assert client.post("/banks", json={"bank_code": "sbi"}, headers={"Authorization": f"Bearer {token}"}).status_code == 201
    assert fake.seen[0].mobile == "9876543210"


# ---- provider independence: only what the provider returns is shown ---------------------------------------------------------


def test_fields_the_provider_does_not_return_stay_empty_and_nothing_is_invented(client, swap_provider):
    swap_provider(Fake([bd.DiscoveredAccount("PRIYA NAIR", "CURRENT", "9087", ifsc=None, branch=None, source="BANKX")]))
    c = new_customer(client, "Neha Kapoor", bank=False)
    b = link(client, c).json()
    assert b["holder_name"] == "PRIYA NAIR"  # the provider's record wins, not the registered name
    assert b["ifsc"] is None and b["branch"] is None
    assert b["account_type"] == "CURRENT" and b["account_ref"].endswith("9087")
    assert b["link_status_label"] == "Linked"  # not described as simulated when it is not
    assert client.get("/banks", headers=c["headers"]).json()[0]["ifsc"] is None


def test_an_unavailable_provider_links_nothing(client, db, swap_provider):
    swap_provider(Fake(error=bd.DiscoveryUnavailable("down")))
    c = new_customer(client, "Neha Kapoor", bank=False)
    r = link(client, c)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "DISCOVERY_UNAVAILABLE" and "Nothing was linked" in r.json()["detail"]["message"]
    assert db.scalar(text("select count(*) from bank_connections")) == 0


def test_no_account_at_that_bank_is_a_clear_not_found(client, db, swap_provider):
    swap_provider(Fake([]))
    c = new_customer(client, "Neha Kapoor", bank=False)
    r = link(client, c)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "NO_ACCOUNT_FOUND"
    assert db.scalar(text("select count(*) from bank_connections")) == 0


@pytest.mark.parametrize("bad", [
    bd.DiscoveredAccount("", "SAVINGS", "1234"), bd.DiscoveredAccount("A B", "CRYPTO", "1234"), bd.DiscoveredAccount("A B", "SAVINGS", "12x4"),
    bd.DiscoveredAccount("A B", "SAVINGS", "1234", ifsc="NOTANIFSC"),
])
def test_a_malformed_provider_record_is_refused_not_patched_up(client, db, swap_provider, bad):
    swap_provider(Fake([bad]))
    c = new_customer(client, "Neha Kapoor", bank=False)
    assert link(client, c).status_code == 503
    assert db.scalar(text("select count(*) from bank_connections")) == 0


def test_an_unconfigured_provider_fails_visibly_instead_of_inventing_data(client, db, monkeypatch):
    monkeypatch.setattr(get_settings(), "bank_discovery_provider", "somebank")
    c = new_customer(client, "Neha Kapoor", bank=False)
    r = link(client, c)
    assert r.status_code == 503 and db.scalar(text("select count(*) from bank_connections")) == 0


def test_the_simulated_record_cannot_be_mistaken_for_a_real_one():
    a = bd.SimulatedDiscoveryProvider().discover(bd.DiscoveryRequest(1, "sbi", "State Bank of India", None, "Asha Rao"))[0]
    assert a.ifsc.startswith("DEMO0") and a.branch.startswith("Demo Branch") and a.source == "SIMULATED"


# ---- nobody sees anybody else's account ---------------------------------------------------------------------------------------


def test_one_customer_cannot_see_or_change_another_customers_account(client):
    a = new_customer(client, "Asha Rao", bank=False)
    b = new_customer(client, "Ravi Shah", bank=False)
    made = link(client, a).json()
    assert client.get("/banks", headers=b["headers"]).json() == []
    for call in (
        lambda: client.post(f"/banks/{made['connection_id']}/default", headers=b["headers"]),
        lambda: client.delete(f"/banks/{made['connection_id']}", headers=b["headers"]),
        lambda: client.patch(f"/banks/{made['connection_id']}/behavior", json={"behavior": "DECLINE"}, headers=b["headers"]),
    ):
        r = call()
        assert r.status_code == 404 and r.json()["detail"]["code"] == "BANK_NOT_FOUND"
    # and B's own link carries B's name, never A's
    theirs = link(client, b).json()
    assert theirs["holder_name"] == "RAVI SHAH" and "ASHA" not in str(theirs)
    assert client.get("/banks", headers=a["headers"]).json() == [made]


def test_anonymous_callers_get_nothing(client):
    assert client.get("/banks").status_code == 401
    assert client.post("/banks", json={"bank_code": "hdfc"}).status_code == 401


def test_a_payers_account_details_are_not_shown_to_the_person_they_pay(client, db, scene_detector, world):
    """The holder name, IFSC and branch are the payer's own information: the recipient's view of a payment must not carry them."""
    from tests.transfer_helpers import pay_transfer

    asha, ravi, _ = world
    mine = client.get("/banks", headers=asha["headers"]).json()[0]
    assert mine["holder_name"] == "ASHA RAO"
    r = pay_transfer(client, asha, ravi, "250.00")
    assert r.status_code == 200, r.text
    feed = client.get("/activity", headers=ravi["headers"])
    assert feed.status_code == 200 and len(feed.json()) == 1
    ref = feed.json()[0]["ref"]
    detail = client.get(f"/activity/{ref}", headers=ravi["headers"])
    receipt = client.get(f"/payments/transactions/{ref}", headers=ravi["headers"])
    assert detail.status_code == 200 and receipt.status_code == 200
    for body in (feed.text, detail.text, receipt.text):
        for secret in (mine["holder_name"], mine["ifsc"], mine["branch"], mine["account_ref"]):
            assert secret not in body


def test_older_demo_links_are_backfilled_with_the_name_only_and_nothing_else_is_invented(client, db):
    """Migration 0013 on existing data: the holder name is filled in the way the simulated record shows it; IFSC and branch stay empty."""
    from alembic import command
    from alembic.config import Config

    from app.database.session import engine

    c = new_customer(client, "Neha  Kapoor", bank=False)
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    command.downgrade(cfg, "0012")
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO bank_connections (connection_id, user_id, bank_code, bank_name, account_type, account_last4, is_default, status, sim_behavior) "
            "VALUES ('bk_old', :u, 'sbi', 'State Bank of India', 'SAVINGS', '4242', true, 'CONNECTED', 'NORMAL')"), {"u": c["id"]})
    command.upgrade(cfg, "head")
    row = client.get("/banks", headers=c["headers"]).json()[0]
    assert row["holder_name"] == "NEHA KAPOOR" and row["ifsc"] is None and row["branch"] is None and row["account_ref"].endswith("4242")
