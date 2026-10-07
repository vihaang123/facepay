from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.core.config import get_settings
from app.core.security import create_access_token
from app.models import Merchant, User

CUSTOMER_ROUTES = [("GET", "/users/me"), ("PATCH", "/users/me")]
MERCHANT_ROUTES = [("GET", "/merchants/me"), ("PATCH", "/merchants/me")]


def _call(client, method, path, headers=None):
    return client.request(method, path, headers=headers, json={} if method == "PATCH" else None)


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _expired_token(sub: int, role: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": str(sub), "role": role, "type": "access", "iat": now - timedelta(hours=2), "exp": now - timedelta(hours=1)},
        s.jwt_secret,
        algorithm=s.jwt_algorithm,
    )


# ---------- unauthenticated access ----------

@pytest.mark.parametrize("method,path", CUSTOMER_ROUTES + MERCHANT_ROUTES)
def test_no_token_is_401_with_bearer_challenge(client, method, path):
    r = _call(client, method, path)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("method,path", CUSTOMER_ROUTES + MERCHANT_ROUTES)
@pytest.mark.parametrize("auth", ["Bearer garbage", "Bearer a.b.c", "Basic abc123", "Bearer "])
def test_bad_tokens_are_401(client, method, path, auth):
    assert _call(client, method, path, {"Authorization": auth}).status_code == 401


def test_expired_token_is_401(client, customer):
    assert client.get("/users/me", headers=_bearer(_expired_token(customer["id"], "customer"))).status_code == 401


def test_token_for_deleted_account_is_401(client, customer, db):
    db.delete(db.get(User, customer["id"]))
    db.commit()
    assert client.get("/users/me", headers=customer["headers"]).status_code == 401


def test_token_with_non_numeric_subject_is_401(client):
    token, _ = create_access_token(1, "customer")
    s = get_settings()
    now = datetime.now(timezone.utc)
    forged = jwt.encode(
        {"sub": "abc", "role": "customer", "type": "access", "exp": now + timedelta(minutes=5)},
        s.jwt_secret,
        algorithm=s.jwt_algorithm,
    )
    assert client.get("/users/me", headers=_bearer(forged)).status_code == 401


def test_disabling_account_blocks_existing_token(client, customer, db):
    assert client.get("/users/me", headers=customer["headers"]).status_code == 200
    db.get(User, customer["id"]).status = "disabled"
    db.commit()
    assert client.get("/users/me", headers=customer["headers"]).status_code == 403


# ---------- role separation ----------

@pytest.mark.parametrize("method,path", CUSTOMER_ROUTES)
def test_merchant_token_cannot_use_customer_routes(client, merchant, method, path):
    assert _call(client, method, path, merchant["headers"]).status_code == 403


@pytest.mark.parametrize("method,path", MERCHANT_ROUTES)
def test_customer_token_cannot_use_merchant_routes(client, customer, method, path):
    assert _call(client, method, path, customer["headers"]).status_code == 403


def test_token_id_collision_across_tables_does_not_cross_roles(client, customer, merchant):
    # Both accounts have id 1 in their own tables; each token must only see its own row.
    assert customer["id"] == merchant["id"] == 1
    assert client.get("/users/me", headers=customer["headers"]).json()["email"] == customer["email"]
    assert client.get("/merchants/me", headers=merchant["headers"]).json()["email"] == merchant["email"]


# ---------- customer profile ----------

def test_customer_profile_read(client, customer):
    r = client.get("/users/me", headers=customer["headers"])
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == customer["email"] and body["name"] == "Test Customer"
    assert set(body) == {"id", "name", "email", "phone", "role", "status", "created_at"}


def test_customer_profile_update(client, customer):
    r = client.patch("/users/me", headers=customer["headers"], json={"name": "  New Name ", "phone": "9876500000"})
    assert r.status_code == 200
    assert r.json()["name"] == "New Name" and r.json()["phone"] == "9876500000"
    assert client.get("/users/me", headers=customer["headers"]).json()["name"] == "New Name"


def test_customer_partial_update_leaves_other_fields(client, customer):
    r = client.patch("/users/me", headers=customer["headers"], json={"name": "Only Name"})
    assert r.json()["name"] == "Only Name" and r.json()["phone"] == "+919876543210"


def test_customer_can_clear_phone_but_not_name(client, customer):
    assert client.patch("/users/me", headers=customer["headers"], json={"phone": None}).json()["phone"] is None
    r = client.patch("/users/me", headers=customer["headers"], json={"name": None})
    assert r.status_code == 200 and r.json()["name"] == "Test Customer"


@pytest.mark.parametrize(
    "payload",
    [
        {"name": ""},
        {"name": "x" * 121},
        {"phone": "not-a-phone"},
        {"email": "hijack@example.com"},
        {"role": "admin"},
        {"status": "active"},
        {"password_hash": "x"},
        {"id": 999},
    ],
)
def test_customer_update_rejects_bad_or_protected_fields(client, customer, db, payload):
    r = client.patch("/users/me", headers=customer["headers"], json=payload)
    assert r.status_code == 422
    user = db.get(User, customer["id"])
    assert user.role == "customer" and user.email == customer["email"] and user.id == customer["id"]


# ---------- merchant profile ----------

def test_merchant_profile_read_and_update(client, merchant):
    r = client.get("/merchants/me", headers=merchant["headers"])
    assert r.status_code == 200 and r.json()["business_name"] == "SuperGrocery"
    assert "password_hash" not in r.json()
    r = client.patch("/merchants/me", headers=merchant["headers"], json={"business_name": "MegaGrocery"})
    assert r.status_code == 200
    assert r.json()["business_name"] == "MegaGrocery" and r.json()["name"] == "Test Owner"


@pytest.mark.parametrize(
    "payload", [{"business_name": ""}, {"name": ""}, {"email": "x@example.com"}, {"password_hash": "x"}]
)
def test_merchant_update_rejects_bad_or_protected_fields(client, merchant, db, payload):
    assert client.patch("/merchants/me", headers=merchant["headers"], json=payload).status_code == 422
    m = db.get(Merchant, merchant["id"])
    assert m.email == merchant["email"] and m.business_name == "SuperGrocery"


def test_password_change_is_not_possible_through_profile(client, customer):
    r = client.patch("/users/me", headers=customer["headers"], json={"password": "Another-pass-9"})
    assert r.status_code == 422
    assert client.post("/auth/login", json={"email": customer["email"], "password": customer["password"]}).status_code == 200
