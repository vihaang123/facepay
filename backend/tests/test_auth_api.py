import pytest
from sqlalchemy import select

from app.core.security import decode_access_token
from app.models import Merchant, User
from tests.conftest import STRONG_PASSWORD, unique_email

CUSTOMER = {"name": "Vihaan G", "phone": "+919876543210", "password": STRONG_PASSWORD}
MERCHANT = {"name": "Owner", "business_name": "SuperGrocery", "password": STRONG_PASSWORD}


# ---------- customer registration ----------

def test_customer_register_success_hides_secrets(client, db):
    email = unique_email()
    r = client.post("/auth/register", json={**CUSTOMER, "email": email})
    assert r.status_code == 201
    body = r.json()
    assert body["email"] == email
    assert body["role"] == "customer" and body["status"] == "active"
    assert "password" not in body and "password_hash" not in body

    stored = db.scalar(select(User).where(User.email == email))
    assert stored.password_hash != STRONG_PASSWORD
    assert stored.password_hash.startswith("$argon2id$")


def test_customer_register_normalizes_email(client):
    r = client.post("/auth/register", json={**CUSTOMER, "email": "  MiXed.Case@Example.COM "})
    assert r.status_code == 201
    assert r.json()["email"] == "mixed.case@example.com"


def test_customer_register_duplicate_email_conflict_case_insensitive(client):
    email = unique_email()
    assert client.post("/auth/register", json={**CUSTOMER, "email": email}).status_code == 201
    r = client.post("/auth/register", json={**CUSTOMER, "email": email.upper()})
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]


def test_customer_register_phone_is_optional_and_normalized(client):
    r = client.post("/auth/register", json={"name": "A", "email": unique_email(), "password": STRONG_PASSWORD})
    assert r.status_code == 201 and r.json()["phone"] is None
    r = client.post(
        "/auth/register",
        json={"name": "B", "email": unique_email(), "phone": "+91 98765-43210", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 201 and r.json()["phone"] == "+919876543210"


@pytest.mark.parametrize(
    "override",
    [
        {"email": "not-an-email"},
        {"email": ""},
        {"password": "short1"},  # too short
        {"password": "allletterspassword"},  # no digit
        {"password": "1234567890"},  # no letter
        {"password": "a1" * 70},  # too long (140)
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 121},
        {"phone": "abc123"},
        {"phone": "12"},
    ],
)
def test_customer_register_validation_rejected(client, override):
    payload = {**CUSTOMER, "email": unique_email(), **override}
    r = client.post("/auth/register", json=payload)
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("missing", ["name", "email", "password"])
def test_customer_register_missing_field_rejected(client, missing):
    payload = {**CUSTOMER, "email": unique_email()}
    del payload[missing]
    assert client.post("/auth/register", json=payload).status_code == 422


def test_register_does_not_let_client_choose_role(client, db):
    email = unique_email()
    r = client.post("/auth/register", json={**CUSTOMER, "email": email, "role": "admin", "status": "disabled"})
    assert r.status_code == 201
    assert r.json()["role"] == "customer" and r.json()["status"] == "active"


# ---------- customer login ----------

def test_customer_login_success_issues_valid_token(client, customer):
    r = client.post("/auth/login", json={"email": customer["email"], "password": customer["password"]})
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer" and body["role"] == "customer"
    claims = decode_access_token(body["access_token"])
    assert claims["sub"] == str(customer["id"]) and claims["role"] == "customer"


def test_customer_login_email_is_case_insensitive(client, customer):
    r = client.post("/auth/login", json={"email": customer["email"].upper(), "password": customer["password"]})
    assert r.status_code == 200


def test_login_failures_are_indistinguishable(client, customer):
    wrong_pw = client.post("/auth/login", json={"email": customer["email"], "password": "Wrong-password-1"})
    no_user = client.post("/auth/login", json={"email": unique_email("ghost"), "password": "Wrong-password-1"})
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json() == no_user.json()


def test_login_requires_password_and_valid_email(client):
    assert client.post("/auth/login", json={"email": "a@example.com", "password": ""}).status_code == 422
    assert client.post("/auth/login", json={"email": "nope", "password": "x"}).status_code == 422


def test_disabled_customer_cannot_login(client, customer, db):
    user = db.get(User, customer["id"])
    user.status = "disabled"
    db.commit()
    r = client.post("/auth/login", json={"email": customer["email"], "password": customer["password"]})
    assert r.status_code == 403


# ---------- merchant registration / login ----------

def test_merchant_register_success_hides_secrets(client, db):
    email = unique_email("m")
    r = client.post("/auth/merchant/register", json={**MERCHANT, "email": email})
    assert r.status_code == 201
    body = r.json()
    assert body["business_name"] == "SuperGrocery"
    assert "password" not in body and "password_hash" not in body
    stored = db.scalar(select(Merchant).where(Merchant.email == email))
    assert stored.password_hash.startswith("$argon2id$")


def test_merchant_register_duplicate_and_validation(client):
    email = unique_email("m")
    assert client.post("/auth/merchant/register", json={**MERCHANT, "email": email}).status_code == 201
    assert client.post("/auth/merchant/register", json={**MERCHANT, "email": email}).status_code == 409
    assert client.post("/auth/merchant/register", json={**MERCHANT, "email": unique_email(), "business_name": ""}).status_code == 422
    assert client.post("/auth/merchant/register", json={**MERCHANT, "email": unique_email(), "password": "weak"}).status_code == 422
    bad = {k: v for k, v in MERCHANT.items() if k != "business_name"}
    assert client.post("/auth/merchant/register", json={**bad, "email": unique_email()}).status_code == 422


def test_merchant_login_success_and_failure(client, merchant):
    ok = client.post("/auth/merchant/login", json={"email": merchant["email"], "password": merchant["password"]})
    assert ok.status_code == 200 and ok.json()["role"] == "merchant"
    assert decode_access_token(ok.json()["access_token"])["role"] == "merchant"
    bad = client.post("/auth/merchant/login", json={"email": merchant["email"], "password": "Wrong-password-1"})
    ghost = client.post("/auth/merchant/login", json={"email": unique_email("g"), "password": "Wrong-password-1"})
    assert bad.status_code == ghost.status_code == 401 and bad.json() == ghost.json()


# ---------- the two account types are separate ----------

def test_customer_credentials_do_not_work_on_merchant_login(client, customer):
    r = client.post("/auth/merchant/login", json={"email": customer["email"], "password": customer["password"]})
    assert r.status_code == 401


def test_merchant_credentials_do_not_work_on_customer_login(client, merchant):
    r = client.post("/auth/login", json={"email": merchant["email"], "password": merchant["password"]})
    assert r.status_code == 401


def test_same_email_can_be_both_customer_and_merchant(client):
    email = unique_email("both")
    assert client.post("/auth/register", json={**CUSTOMER, "email": email}).status_code == 201
    assert client.post("/auth/merchant/register", json={**MERCHANT, "email": email}).status_code == 201


# ---------- rate limiting ----------

@pytest.fixture
def limiter_on():
    from app.core.rate_limit import auth_limiter

    old = (auth_limiter.enabled, auth_limiter.max_requests)
    auth_limiter.enabled, auth_limiter.max_requests = True, 3
    auth_limiter.reset()
    yield
    auth_limiter.enabled, auth_limiter.max_requests = old
    auth_limiter.reset()


def test_login_is_rate_limited(client, limiter_on):
    payload = {"email": unique_email(), "password": "Wrong-password-1"}
    codes = [client.post("/auth/login", json=payload).status_code for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]
    blocked = client.post("/auth/login", json=payload)
    assert blocked.headers["retry-after"] == "60"


def test_rate_limit_is_per_endpoint(client, limiter_on):
    payload = {"email": unique_email(), "password": "Wrong-password-1"}
    for _ in range(4):
        client.post("/auth/login", json=payload)
    # customer login is exhausted, merchant login is a separate bucket
    assert client.post("/auth/merchant/login", json=payload).status_code == 401


def test_registration_is_rate_limited(client, limiter_on):
    codes = [
        client.post("/auth/register", json={**CUSTOMER, "email": unique_email()}).status_code
        for _ in range(5)
    ]
    assert codes == [201, 201, 201, 429, 429]


# ---------- validation errors must not echo secrets ----------

def test_validation_errors_do_not_echo_submitted_password(client):
    secret = "Qx7!"  # too short, so it is rejected
    r = client.post("/auth/register", json={**CUSTOMER, "email": unique_email(), "password": secret})
    assert r.status_code == 422
    assert secret not in r.text
    for item in r.json()["detail"]:
        assert set(item) == {"type", "loc", "msg"}
    assert r.json()["detail"][0]["loc"] == ["body", "password"]


def test_login_validation_errors_do_not_echo_input(client):
    r = client.post("/auth/login", json={"email": "not-an-email", "password": "MySecret-9"})
    assert r.status_code == 422
    assert "MySecret-9" not in r.text and "input" not in r.text
