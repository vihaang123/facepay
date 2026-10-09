"""FacePay ID: one canonical, unique, server-validated payment handle per customer; lookup that reveals only a name and a
masked ID; QR payloads that carry an identifier and nothing else."""

import re
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.api import transfers as transfers_api
from app.core import facepay_id as fid
from app.core.config import get_settings
from app.models import FacePayIdHistory, User
from tests.conftest import STRONG_PASSWORD, unique_email
from tests.payment_helpers import new_customer, new_merchant

CANONICAL = re.compile(r"^[a-z0-9]+([._][a-z0-9]+)*@facepay$")


def code(r):
    return r.json()["detail"]["code"]


def me(client, c):
    return client.get("/facepay/me", headers=c["headers"]).json()


# ============================================================ generation and uniqueness


def test_every_customer_gets_a_readable_canonical_facepay_id(client):
    c = new_customer(client, "Vihaan Gandhi")
    p = me(client, c)
    assert p["facepay_id"] == "vihaan@facepay" and CANONICAL.match(p["facepay_id"])
    assert client.get("/users/me", headers=c["headers"]).json()["facepay_id"] == "vihaan@facepay"


def test_customers_with_the_same_first_name_get_different_ids(client):
    ids = {me(client, new_customer(client, f"Vihaan {s}"))["facepay_id"] for s in ("Gandhi", "Shah", "Rao", "Iyer")}
    assert len(ids) == 4 and all(CANONICAL.match(i) for i in ids)


@pytest.mark.parametrize("name", ["Admin", "Support", "Jo", "Ünal Åke", "O'Brien", "李雷"])
def test_awkward_names_still_give_valid_unreserved_ids(client, name):
    p = me(client, new_customer(client, name))
    assert CANONICAL.match(p["facepay_id"]) and fid.handle_of(p["facepay_id"]) not in fid.RESERVED
    assert 3 <= len(fid.handle_of(p["facepay_id"])) <= 24


def test_the_database_itself_refuses_a_duplicate_or_malformed_id(client, db):
    a = new_customer(client, "Asha Rao")
    other = User(name="Dup", email=unique_email("dup"), password_hash="x", facepay_id=me(client, a)["facepay_id"])
    db.add(other)
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    for bad in ("UPPER@facepay", "no-domain", "a b@facepay", "x@bank", "..@facepay"):
        db.add(User(name="Bad", email=unique_email("bad"), password_hash="x", facepay_id=bad))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_registration_cannot_choose_or_override_the_id_or_role(client):
    email = unique_email("sneak")
    r = client.post(
        "/auth/register",
        json={"name": "Sneaky", "email": email, "password": STRONG_PASSWORD, "facepay_id": "ceo@facepay", "role": "admin", "balance": "999999"},
    )
    assert r.status_code == 201 and r.json()["facepay_id"] != "ceo@facepay" and r.json()["role"] == "customer"


def test_profile_update_cannot_touch_id_balance_or_role(client, customer):
    for field, value in (("facepay_id", "ceo@facepay"), ("balance", "99999"), ("role", "admin"), ("email", "x@example.com")):
        assert client.patch("/users/me", json={field: value}, headers=customer["headers"]).status_code == 422


# ============================================================ normalisation


@pytest.mark.parametrize(
    "raw,expected",
    [("Vihaan@FacePay", "vihaan@facepay"), ("  vihaan  ", "vihaan@facepay"), ("VIHAAN", "vihaan@facepay"), ("a.b_c9@facepay", "a.b_c9@facepay")],
)
def test_ids_are_normalised_the_same_way_everywhere(raw, expected):
    assert fid.normalize(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "ab", "a" * 25, "has space", "dots..twice", ".leading", "trailing.", "under__score", "name@bank", "a@b@facepay", "vihaan@facepay.com",
     "ｖihaan", "vihаan", "admin", "support@facepay", "name​@facepay", "pay;drop", "x" * 200, "a\nb"],
)
def test_invalid_ids_are_refused(raw):
    with pytest.raises(fid.InvalidFacePayId):
        fid.normalize(raw)


def test_masking_hides_most_of_the_handle():
    assert fid.mask("vihaan@facepay") == "vi***n@facepay"
    assert fid.mask("abc@facepay") == "a**@facepay"
    assert "vihaa" not in fid.mask("vihaan@facepay")


# ============================================================ changing an ID


def test_a_customer_can_rename_to_a_free_id_and_the_old_one_stops_resolving(client, customer):
    other = new_customer(client, "Ravi Shah")
    old = me(client, customer)["facepay_id"]
    r = client.put("/facepay/me", json={"facepay_id": "Asha.Rao@FacePay"}, headers=customer["headers"])
    assert r.status_code == 200 and r.json()["facepay_id"] == "asha.rao@facepay"
    assert client.get("/facepay/resolve", params={"id": old}, headers=other["headers"]).status_code == 404
    assert client.get("/facepay/resolve", params={"id": "asha.rao"}, headers=other["headers"]).status_code == 200


def test_nobody_can_take_an_id_that_belongs_to_another_account(client, customer):
    other = new_customer(client, "Ravi Shah")
    taken = me(client, other)["facepay_id"]
    for variant in (taken, taken.upper(), taken.removesuffix("@facepay"), f"  {taken}  "):
        r = client.put("/facepay/me", json={"facepay_id": variant}, headers=customer["headers"])
        assert r.status_code == 409 and code(r) == "FACEPAY_ID_TAKEN"
    assert me(client, other)["facepay_id"] == taken


def test_a_retired_id_stays_reserved_for_its_owner(client, customer, db):
    other = new_customer(client, "Ravi Shah")
    old = me(client, customer)["facepay_id"]
    assert client.put("/facepay/me", json={"facepay_id": "asha.new"}, headers=customer["headers"]).status_code == 200
    r = client.put("/facepay/me", json={"facepay_id": old}, headers=other["headers"])
    assert r.status_code == 409 and code(r) == "FACEPAY_ID_TAKEN"  # cannot take over a handle others may have saved
    assert db.scalar(select(FacePayIdHistory.user_id).where(FacePayIdHistory.facepay_id == old)) == customer["id"]


def test_renaming_is_rate_limited_by_a_cooldown_and_the_owner_can_go_back_afterwards(client, customer, db):
    old = me(client, customer)["facepay_id"]
    assert client.put("/facepay/me", json={"facepay_id": "asha.new"}, headers=customer["headers"]).status_code == 200
    p = me(client, customer)
    assert p["can_change"] is False and p["next_change_at"] is not None
    r = client.put("/facepay/me", json={"facepay_id": "asha.again"}, headers=customer["headers"])
    assert r.status_code == 429 and code(r) == "FACEPAY_ID_COOLDOWN"
    db.execute(text("update users set facepay_id_changed_at = :t where id = :i"), {"t": datetime.now(UTC) - timedelta(days=get_settings().facepay_id_change_cooldown_days + 1), "i": customer["id"]})
    db.commit()
    r = client.put("/facepay/me", json={"facepay_id": old}, headers=customer["headers"])  # back to one of their own earlier IDs
    assert r.status_code == 200 and r.json()["facepay_id"] == old


@pytest.mark.parametrize("bad", ["ab", "admin", "has space", "x@bank", "vihаan", "a" * 30])
def test_invalid_rename_is_refused_with_a_message(client, customer, bad):
    r = client.put("/facepay/me", json={"facepay_id": bad}, headers=customer["headers"])
    assert r.status_code == 422 and code(r) == "FACEPAY_ID_INVALID" and r.json()["detail"]["message"]


def test_renaming_to_the_current_id_is_a_no_op_error(client, customer):
    r = client.put("/facepay/me", json={"facepay_id": me(client, customer)["facepay_id"]}, headers=customer["headers"])
    assert r.status_code == 409 and code(r) == "FACEPAY_ID_UNCHANGED"


# ============================================================ resolving a recipient


def test_resolve_returns_only_a_name_and_a_masked_id(client, customer):
    other = new_customer(client, "Ravi Shah")
    r = client.get("/facepay/resolve", params={"id": me(client, other)["facepay_id"]}, headers=customer["headers"])
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"display_name", "masked_id", "is_self"} and body["display_name"] == "Ravi Shah" and body["is_self"] is False
    assert body["masked_id"] == fid.mask(me(client, other)["facepay_id"])
    text_ = r.text.lower()
    assert other["email"] not in text_ and "email" not in text_ and "phone" not in text_ and str(other["id"]) not in body.values()


def test_resolving_your_own_id_is_flagged(client, customer):
    r = client.get("/facepay/resolve", params={"id": me(client, customer)["facepay_id"]}, headers=customer["headers"])
    assert r.json()["is_self"] is True


@pytest.mark.parametrize("raw", ["nobody.here", "nobody@facepay", "admin", "bad id!", "x" * 60])
def test_unknown_and_malformed_ids_look_identical(client, customer, raw):
    r = client.get("/facepay/resolve", params={"id": raw}, headers=customer["headers"])
    assert r.status_code == 404 and code(r) == "RECIPIENT_NOT_FOUND"


def test_a_disabled_account_cannot_be_resolved(client, customer, db):
    other = new_customer(client, "Ravi Shah")
    their_id = me(client, other)["facepay_id"]
    db.execute(text("update users set status = 'disabled' where id = :i"), {"i": other["id"]})
    db.commit()
    assert client.get("/facepay/resolve", params={"id": their_id}, headers=customer["headers"]).status_code == 404


def test_lookup_needs_a_customer_session_and_is_rate_limited(client, customer, monkeypatch):
    assert client.get("/facepay/resolve", params={"id": "x"}).status_code == 401
    merchant = new_merchant(client)
    assert client.get("/facepay/resolve", params={"id": "someone"}, headers=merchant["headers"]).status_code == 403
    monkeypatch.setattr(transfers_api.resolve_limiter, "enabled", True)
    transfers_api.resolve_limiter.reset()
    try:
        codes = [client.get("/facepay/resolve", params={"id": "nobody.here"}, headers=customer["headers"]).status_code for _ in range(get_settings().resolve_rate_limit_per_minute + 3)]
        assert codes[-1] == 429 and codes[0] == 404
    finally:
        transfers_api.resolve_limiter.reset()


# ============================================================ QR


def test_my_qr_encodes_only_the_facepay_id(client, customer):
    p = me(client, customer)
    assert p["qr_payload"] == f"facepay://pay/{p['facepay_id']}"
    for secret in (customer["email"], "Bearer", "eyJ", customer["headers"]["Authorization"][7:20]):
        assert secret not in p["qr_payload"]


def test_scanning_a_pay_code_resolves_the_recipient_on_the_server(client, customer):
    other = new_customer(client, "Ravi Shah")
    r = client.post("/facepay/qr/resolve", json={"payload": me(client, other)["qr_payload"]}, headers=customer["headers"])
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "PAY" and body["recipient"]["display_name"] == "Ravi Shah" and body["request"] is None
    assert set(body["recipient"]) == {"display_name", "masked_id", "is_self"}


def test_a_bare_id_is_accepted_as_the_manual_fallback(client, customer):
    other = new_customer(client, "Ravi Shah")
    r = client.post("/facepay/qr/resolve", json={"payload": me(client, other)["facepay_id"].upper()}, headers=customer["headers"])
    assert r.status_code == 200 and r.json()["recipient"]["display_name"] == "Ravi Shah"


@pytest.mark.parametrize(
    "payload",
    ["https://evil.example/pay?to=x", "javascript:alert(1)", "facepay://pay/", "facepay://pay/../../etc", "facepay://admin/x", "facepay://pay/a b",
     "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "upi://pay?pa=someone@bank&am=500", "x" * 150, "facepay://pay/nope@bank"],
)
def test_foreign_or_malformed_codes_are_refused(client, customer, payload):
    r = client.post("/facepay/qr/resolve", json={"payload": payload}, headers=customer["headers"])
    assert r.status_code == 422 and code(r) == "QR_INVALID"


def test_a_code_for_an_unknown_id_is_not_found(client, customer):
    r = client.post("/facepay/qr/resolve", json={"payload": "facepay://pay/ghost.user@facepay"}, headers=customer["headers"])
    assert r.status_code == 404 and code(r) == "RECIPIENT_NOT_FOUND"


def test_oversized_code_payloads_are_rejected_before_parsing(client, customer):
    assert client.post("/facepay/qr/resolve", json={"payload": "x" * 5000}, headers=customer["headers"]).status_code == 422


# ============================================================ contacts


def test_contacts_are_only_people_you_actually_dealt_with(client, customer):
    stranger = new_customer(client, "Stranger Danger")
    asked = new_customer(client, "Ravi Shah")
    assert client.get("/facepay/contacts", headers=customer["headers"]).json() == []
    r = client.post("/requests", json={"payer_facepay_id": me(client, asked)["facepay_id"], "amount": "100.00"}, headers=customer["headers"])
    assert r.status_code == 201
    names = [c["display_name"] for c in client.get("/facepay/contacts", headers=customer["headers"]).json()]
    assert names == ["Ravi Shah"] and "Stranger Danger" not in names
    assert [c["display_name"] for c in client.get("/facepay/contacts", headers=asked["headers"]).json()] == ["Test Customer"]
    assert client.get("/facepay/contacts", headers=stranger["headers"]).json() == []
