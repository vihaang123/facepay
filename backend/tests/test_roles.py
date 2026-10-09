"""Role separation is enforced by the API, not by the screens: customers, merchants and admins each reach only their own routes."""

from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app import cli
from app.core.security import create_access_token
from app.models import User
from tests.conftest import STRONG_PASSWORD
from tests.payment_helpers import authorize, confirm, create_session

pytestmark = pytest.mark.usefixtures("scene_detector")  # camera frames in these tests are synthetic scenes


ADMIN_ROUTES = ["/admin/ml/overview", "/admin/ml/analysis", "/admin/ml/benchmark", "/admin/ml/outcomes"]


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def promote(db, cust, role="admin"):
    db.execute(update(User).where(User.id == cust["id"]).values(role=role))
    db.commit()


def admin_login(client, cust):
    r = client.post("/auth/login", json={"email": cust["email"], "password": cust["password"]})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def admin(client, db, customer):
    promote(db, customer)
    tok = admin_login(client, customer)
    assert tok["role"] == "admin"
    return {**customer, "headers": bearer(tok["access_token"])}


@pytest.mark.parametrize("route", ADMIN_ROUTES)
def test_only_an_admin_reaches_the_ml_lab(client, customer, merchant, admin, route):
    assert client.get(route).status_code in (401, 403)
    assert client.get(route, headers=bearer("not.a.token")).status_code == 401
    assert client.get(route, headers=customer["headers"]).status_code == 403 if customer is not admin else True
    assert client.get(route, headers=merchant["headers"]).status_code == 403
    assert client.get(route, headers=admin["headers"]).status_code == 200


def test_a_customer_cannot_become_an_admin_through_the_api(client, customer, merchant):
    for path, body in (
        ("/auth/register", {"name": "X Y", "email": "sneaky@example.com", "phone": "+919876543211", "password": STRONG_PASSWORD, "role": "admin"}),
        ("/auth/merchant/register", {"name": "O", "business_name": "Evil", "email": "evil@example.com", "password": STRONG_PASSWORD, "role": "admin"}),
    ):
        r = client.post(path, json=body)
        assert r.status_code in (201, 422)
        if r.status_code == 201:
            assert r.json().get("role", "customer") != "admin"
    tok = client.post("/auth/login", json={"email": "sneaky@example.com", "password": STRONG_PASSWORD})
    assert tok.status_code == 200 and tok.json()["role"] == "customer"
    assert client.put("/facepay/me", json={"role": "admin", "facepay_id": "sneaky.one"}, headers=customer["headers"]).status_code in (200, 422)
    assert client.get("/admin/ml/overview", headers=customer["headers"]).status_code == 403
    # merchants cannot hold the admin role either: their token role is always "merchant"
    assert client.post("/auth/merchant/login", json={"email": merchant["email"], "password": STRONG_PASSWORD}).json()["role"] == "merchant"


def test_a_forged_role_in_a_signed_token_still_needs_the_database(client, db, customer):
    forged, _ = create_access_token(customer["id"], "admin")  # signed correctly, but the account is not an admin
    assert client.get("/admin/ml/overview", headers=bearer(forged)).status_code == 403
    merchant_claim, _ = create_access_token(customer["id"], "merchant")
    assert client.get("/merchant/transactions", headers=bearer(merchant_claim)).status_code in (401, 403, 404)
    assert client.get("/wallet", headers=bearer(merchant_claim)).status_code in (401, 403)


def test_a_token_minted_before_promotion_stays_a_customer_token(client, db, customer):
    old = customer["headers"]
    promote(db, customer)
    assert client.get("/admin/ml/overview", headers=old).status_code == 403  # role claim in that token is still "customer"
    new = bearer(admin_login(client, customer)["access_token"])
    assert client.get("/admin/ml/overview", headers=new).status_code == 200


def test_demotion_and_suspension_take_effect_immediately(client, db, admin):
    assert client.get("/admin/ml/overview", headers=admin["headers"]).status_code == 200
    db.execute(update(User).where(User.id == admin["id"]).values(status="disabled"))
    db.commit()
    assert client.get("/admin/ml/overview", headers=admin["headers"]).status_code in (401, 403)
    db.execute(update(User).where(User.id == admin["id"]).values(status="active", role="customer"))
    db.commit()
    assert client.get("/admin/ml/overview", headers=admin["headers"]).status_code == 403


def test_an_admin_is_not_a_merchant_and_a_merchant_is_not_a_customer(client, admin, merchant, customer):
    assert client.get("/merchant/transactions", headers=admin["headers"]).status_code == 403
    assert client.get("/merchant/security-summary", headers=customer["headers"]).status_code == 403
    assert client.get("/merchant/security-summary", headers=merchant["headers"]).status_code == 200
    for route in ("/wallet", "/activity", "/facepay/me", "/requests", "/faces/model"):
        assert client.get(route, headers=merchant["headers"]).status_code in (401, 403), route


def test_the_merchant_summary_is_scoped_to_that_merchant(client, world, shop):
    asha, _, _ = world
    other = __import__("tests.payment_helpers", fromlist=["new_merchant"]).new_merchant(client, "Other Shop")
    sid = create_session(client, shop, amount="120.00", ref="SG-9")["session_id"]
    assert confirm(client, asha, sid, authorize(client, asha, sid)).status_code == 200
    mine = client.get("/merchant/security-summary", headers=shop["headers"]).json()
    theirs = client.get("/merchant/security-summary", headers=other["headers"]).json()
    assert str(mine) != str(theirs)
    blob = str(mine).lower()
    for banned in ("embedding", "vector", "distance", "confidence", "pca", "lda", "image", "asha", "email"):
        assert banned not in blob, banned
    assert client.get("/merchant/transactions", headers=other["headers"]).json() == []
    assert client.get(f"/merchant/sessions/{sid}", headers=other["headers"]).status_code in (403, 404)


def test_customers_never_receive_model_internals(client, world):
    asha, _, _ = world
    m = client.get("/faces/model", headers=asha["headers"]).json()
    inner = m["model"] or {}
    assert set(inner) <= {"version", "trained_at", "includes_you", "stale"}
    blob = str(client.get("/faces/status", headers=asha["headers"]).json()).lower() + str(m).lower()
    for banned in ("explained_variance", "confusion", "eigen", "threshold", "distance", "confidence", "classifier", "dataset_fingerprint"):
        assert banned not in blob, banned


def test_the_admin_ml_lab_payloads_are_aggregate_and_honest(client, world, admin):
    over = client.get("/admin/ml/overview", headers=admin["headers"]).json()
    assert over["training_status"] in {"current", "stale", "no_model"} and over["model"]["version"]
    assert over["dataset"]["enrolled_customers"] >= 2 and "caveat" in over["methodology"]
    an = client.get("/admin/ml/analysis", headers=admin["headers"]).json()
    assert an["available"] is True
    cum = an["pca"]["cumulative_variance"]
    assert cum == sorted(cum) and 0 < cum[-1] <= 1.0001 and len(cum) == an["pca"]["components"]
    assert abs(sum(an["pca"]["explained_variance_ratio"]) - cum[-1]) < 1e-3
    for c in an["classifiers"].values():
        assert all(name.startswith("C") for name in c["classes"])
        cm = c["confusion_matrix"]
        assert len(cm) == len(c["classes"]) and all(len(row) == len(cm) for row in cm)
    text = str(an).lower() + str(over).lower()
    for _, who in zip(range(2), world, strict=False):
        assert who["email"].lower() not in text and str(who["facepay_id"]).lower() not in text
    bench = client.get("/admin/ml/benchmark", headers=admin["headers"]).json()
    assert bench["available"] is True and "not a measurement" in str(bench).lower() or "orl" in str(bench).lower()
    out = client.get("/admin/ml/outcomes", params={"days": 7}, headers=admin["headers"]).json()
    assert out["attempts"] == out["successful"] + out["failed"]
    assert sum(c["count"] for c in out["failure_categories"]) == out["failed"]
    assert client.get("/admin/ml/outcomes", params={"days": 0}, headers=admin["headers"]).status_code == 422


def test_admin_with_no_model_reports_unavailable_instead_of_inventing_numbers(client, admin):
    an = client.get("/admin/ml/analysis", headers=admin["headers"]).json()
    assert an["available"] is False and "pca" not in an
    assert client.get("/admin/ml/overview", headers=admin["headers"]).json()["model"] is None


def test_cli_grants_and_removes_the_admin_role(client, db, customer, monkeypatch, capsys):
    from app.database import session as sess
    monkeypatch.setattr(cli, "SessionLocal", sess.SessionLocal)
    assert cli.main(["create-admin", "nobody@example.com"]) == 1
    assert cli.main(["create-admin", customer["email"].upper()]) == 0
    db.expire_all()
    assert db.scalar(select(User.role).where(User.id == customer["id"])) == "admin"
    assert cli.main(["remove-admin", customer["email"]]) == 0
    db.expire_all()
    assert db.scalar(select(User.role).where(User.id == customer["id"])) == "customer"
    assert cli.main(["reconcile-ledger"]) == 0 and cli.main(["bogus"]) == 64


def test_every_new_customer_gets_an_opening_grant_that_reconciles(client, db, customer):
    from app.services import ledger_service
    w = client.get("/wallet", headers=customer["headers"]).json()
    assert Decimal(w["balance"]) == Decimal("10000.00")
    assert [e["type"] if "type" in e else e.get("entry_type") for e in w["entries"]] and ledger_service.reconcile(db) == []
    assert "simulated" in str(w).lower()
