"""Mobile-number sign-up and sign-in (simulated: the one-time code is a demo code shown on screen)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from app.core import mobile as mobile_rules
from app.core.config import get_settings
from app.models import Merchant, MobileNumber, OtpChallenge, SigninAttempt, User
from tests.conftest import STRONG_PASSWORD, unique_email

NUM = "9876543210"
PASSCODE = "482915"


def otp(client, mobile=NUM, purpose="signup"):
    r = client.post("/auth/number/otp", json={"mobile": mobile, "purpose": purpose})
    return r


def verified_challenge(client, mobile=NUM, purpose="signup"):
    r = otp(client, mobile, purpose)
    assert r.status_code == 200, r.text
    body = r.json()
    v = client.post("/auth/number/verify", json={"challenge_id": body["challenge_id"], "code": body["demo_code"]})
    assert v.status_code == 200, v.text
    return body["challenge_id"]


def signup(client, mobile=NUM, passcode=PASSCODE, **extra):
    cid = verified_challenge(client, mobile)
    payload = {"challenge_id": cid, "name": "Asha Rao", "passcode": passcode, "agreed": True, **extra}
    return client.post("/auth/number/signup", json=payload)


def signin(client, mobile=NUM, passcode=PASSCODE):
    return client.post("/auth/number/signin", json={"mobile": mobile, "passcode": passcode})


# ---- number and passcode rules ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["9876543210", "+91 98765 43210", "98765-43210", "919876543210", "09876543210", " 98765 43210 "])
def test_number_is_normalised(raw):
    assert mobile_rules.normalize(raw) == "9876543210"


@pytest.mark.parametrize("raw", ["", "12345", "5876543210", "98765432101", "abcdefghij", None, "+1 415 555 0100"])
def test_bad_numbers_are_refused(raw):
    with pytest.raises(mobile_rules.InvalidMobile):
        mobile_rules.normalize(raw)


@pytest.mark.parametrize("bad", ["12345", "1234567", "abcdef", "123456", "654321", "111111", "123123", "000000", "12 456"])
def test_weak_or_malformed_passcodes_are_refused(bad):
    with pytest.raises(ValueError):
        mobile_rules.check_passcode(bad)


def test_reasonable_passcode_is_accepted():
    assert mobile_rules.check_passcode("482915") == "482915"


def test_mask_hides_the_front_of_the_number():
    assert mobile_rules.mask(NUM) == "+91 •••••43210"


# ---- one-time (demo) code ----------------------------------------------------------------------------------------------------


def test_otp_is_a_labelled_demo_and_stores_only_a_hash(client, db):
    body = otp(client).json()
    assert body["demo"] is True and len(body["demo_code"]) == 6 and body["mobile_masked"] == "+91 •••••43210"
    row = db.scalar(select(OtpChallenge))
    assert row.code_hash != body["demo_code"] and len(row.code_hash) == 64


def test_wrong_code_is_counted_and_blocks_after_the_limit(client, db):
    body = otp(client).json()
    wrong = "000000" if body["demo_code"] != "000000" else "111111"
    for _ in range(get_settings().otp_max_attempts):
        assert client.post("/auth/number/verify", json={"challenge_id": body["challenge_id"], "code": wrong}).status_code == 400
    # Even the right code no longer works: the challenge is spent.
    r = client.post("/auth/number/verify", json={"challenge_id": body["challenge_id"], "code": body["demo_code"]})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "OTP_INVALID"


def test_expired_code_is_refused(client, db):
    body = otp(client).json()
    db.execute(text("UPDATE otp_challenges SET expires_at = now() - interval '1 second'"))
    db.commit()
    r = client.post("/auth/number/verify", json={"challenge_id": body["challenge_id"], "code": body["demo_code"]})
    assert r.status_code == 400


def test_unknown_challenge_is_refused(client):
    r = client.post("/auth/number/verify", json={"challenge_id": "x" * 20, "code": "123456"})
    assert r.status_code == 400


def test_codes_cannot_be_asked_for_in_a_burst(client, db):
    assert otp(client).status_code == 200
    r = otp(client)  # immediately again
    assert r.status_code == 429 and r.json()["detail"]["code"] == "OTP_UNAVAILABLE"
    # Past the resend wait the next one is allowed, until the per-window cap.
    for _ in range(4):
        db.execute(text("UPDATE otp_challenges SET created_at = created_at - interval '1 minute'"))
        db.commit()
        assert otp(client).status_code == 200
    db.execute(text("UPDATE otp_challenges SET created_at = created_at - interval '1 minute'"))
    db.commit()
    assert otp(client).status_code == 429


def test_demo_mode_off_means_no_code_is_ever_returned(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "demo_otp_enabled", False)
    r = otp(client)
    assert r.status_code == 503 and "demo_code" not in r.text


def test_bad_number_is_a_validation_error(client):
    r = client.post("/auth/number/otp", json={"mobile": "12345"})
    assert r.status_code == 422


# ---- sign up ---------------------------------------------------------------------------------------------------------------


def test_signup_creates_a_customer_and_returns_a_working_token(client, db):
    r = signup(client)
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "customer"
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    me = client.get("/users/me", headers=headers).json()
    assert me["mobile"] == NUM and me["email"] is None and me["name"] == "Asha Rao" and me["facepay_id"]
    user = db.scalar(select(User))
    assert user.passcode_hash and PASSCODE not in user.passcode_hash and user.passcode_hash.startswith("$argon2")
    assert db.get(MobileNumber, NUM).user_id == user.id


def test_signup_needs_the_prototype_agreement(client):
    cid = verified_challenge(client)
    r = client.post("/auth/number/signup", json={"challenge_id": cid, "name": "A", "passcode": PASSCODE, "agreed": False})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "NOT_AGREED"


def test_signup_refuses_a_weak_passcode(client):
    cid = verified_challenge(client)
    r = client.post("/auth/number/signup", json={"challenge_id": cid, "name": "A", "passcode": "123456", "agreed": True})
    assert r.status_code == 422


def test_signup_needs_a_verified_code(client):
    body = otp(client).json()  # asked for, never verified
    r = client.post("/auth/number/signup", json={"challenge_id": body["challenge_id"], "name": "A", "passcode": PASSCODE, "agreed": True})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "OTP_INVALID"


def test_a_verified_code_is_single_use(client):
    cid = verified_challenge(client)
    body = {"challenge_id": cid, "name": "A", "passcode": PASSCODE, "agreed": True}
    assert client.post("/auth/number/signup", json=body).status_code == 201
    assert client.post("/auth/number/signup", json=body).status_code == 400


def test_a_challenge_cannot_be_used_for_a_different_number(client, db):
    """The number is fixed when the code is issued; signup takes it from the challenge, not from the request."""
    cid = verified_challenge(client, "9876500001")
    r = client.post("/auth/number/signup", json={"challenge_id": cid, "name": "A", "passcode": PASSCODE, "agreed": True, "mobile": NUM})
    assert r.status_code == 201
    assert db.get(MobileNumber, "9876500001") is not None and db.get(MobileNumber, NUM) is None


def test_one_number_one_account(client):
    assert signup(client).status_code == 201
    r = otp(client)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "NUMBER_REGISTERED"


def test_two_signups_racing_for_one_number_make_one_account(client, db):
    """Both got a verified code before either finished: the registry's primary key lets only one win."""
    first = verified_challenge(client)
    db.execute(text("UPDATE otp_challenges SET created_at = created_at - interval '1 minute'"))
    db.commit()
    second = verified_challenge(client)
    body = {"name": "A", "passcode": PASSCODE, "agreed": True}
    assert client.post("/auth/number/signup", json={**body, "challenge_id": first}).status_code == 201
    r = client.post("/auth/number/signup", json={**body, "challenge_id": second})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "NUMBER_REGISTERED"
    assert db.scalar(text("SELECT count(*) FROM users")) == 1


def test_merchant_signup_by_number(client, db):
    r = signup(client, "9123456789", account_type="merchant", business_name="Chai Point")
    assert r.status_code == 201 and r.json()["role"] == "merchant"
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    me = client.get("/merchants/me", headers=headers).json()
    assert me["business_name"] == "Chai Point" and me["mobile"] == "9123456789" and me["email"] is None
    assert db.get(MobileNumber, "9123456789").merchant_id == me["id"]


def test_merchant_signup_needs_a_business_name(client):
    r = signup(client, "9123456789", account_type="merchant")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "BUSINESS_NAME_REQUIRED"


def test_registry_check_constraints_hold(db):
    with pytest.raises(Exception):
        db.execute(text("INSERT INTO mobile_numbers (mobile, account_type, user_id) VALUES ('1234567890', 'user', 1)"))
        db.commit()
    db.rollback()
    with pytest.raises(Exception):
        db.execute(text("INSERT INTO mobile_numbers (mobile, account_type) VALUES ('9876543210', 'user')"))
        db.commit()
    db.rollback()


# ---- sign in ---------------------------------------------------------------------------------------------------------------


def test_signin_with_number_and_passcode(client):
    signup(client)
    r = signin(client)
    assert r.status_code == 200 and r.json()["role"] == "customer"
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/users/me", headers=headers).status_code == 200


def test_signin_accepts_the_number_as_people_type_it(client):
    signup(client)
    assert signin(client, "+91 98765 43210").status_code == 200


def test_merchant_signs_in_with_a_number_too(client):
    signup(client, "9123456789", account_type="merchant", business_name="Chai Point")
    r = signin(client, "9123456789")
    assert r.status_code == 200 and r.json()["role"] == "merchant"
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/merchants/me", headers=headers).status_code == 200


def test_wrong_passcode_and_unknown_number_look_the_same(client):
    signup(client)
    wrong = signin(client, passcode="000001")
    unknown = signin(client, "9000000001", "000001")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


def test_the_number_locks_after_repeated_wrong_passcodes(client, db):
    signup(client)
    n = get_settings().signin_max_failures
    for _ in range(n):
        assert signin(client, passcode="000001").status_code == 401
    locked = signin(client)  # even the right passcode is refused while locked
    assert locked.status_code == 429 and locked.json()["detail"]["code"] == "SIGNIN_LOCKED"
    assert "Retry-After" in locked.headers
    # Time passes: the lock ends and the right passcode works again.
    db.execute(text("UPDATE signin_attempts SET locked_until = now() - interval '1 second'"))
    db.commit()
    assert signin(client).status_code == 200


def test_unknown_numbers_lock_too_so_a_lock_reveals_nothing(client):
    for _ in range(get_settings().signin_max_failures):
        assert signin(client, "9000000002", "000001").status_code == 401
    assert signin(client, "9000000002", "000001").status_code == 429


def test_success_resets_the_failure_count(client, db):
    signup(client)
    for _ in range(get_settings().signin_max_failures - 1):
        signin(client, passcode="000001")
    assert signin(client).status_code == 200
    assert db.scalar(select(SigninAttempt.failed_count)) == 0
    for _ in range(get_settings().signin_max_failures - 1):
        assert signin(client, passcode="000001").status_code == 401  # not locked yet: the count started over


def test_disabled_account_cannot_sign_in(client, db):
    signup(client)
    db.execute(text("UPDATE users SET status = 'disabled'"))
    db.commit()
    r = signin(client)
    assert r.status_code == 403


def test_passcode_is_peppered_with_the_number(client, db):
    """The stored hash is of the passcode mixed with the number and a server secret, never of the bare passcode."""
    from app.core.security import verify_password

    signup(client)
    hash_ = db.scalar(select(User.passcode_hash))
    assert not verify_password(PASSCODE, hash_)  # the bare passcode alone does not match


def test_number_sign_in_is_rate_limited_per_address(client, monkeypatch):
    from app.core.rate_limit import auth_limiter

    monkeypatch.setattr(auth_limiter, "enabled", True)
    monkeypatch.setattr(auth_limiter, "max_requests", 3)
    codes = [signin(client, "9000000003", "000001").status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401] and codes[3:] == [429, 429]


# ---- older (email) accounts ------------------------------------------------------------------------------------------------


def test_email_login_still_works_for_older_accounts(client, customer):
    r = client.post("/auth/login", json={"email": customer["email"], "password": STRONG_PASSWORD})
    assert r.status_code == 200


def test_number_accounts_have_no_usable_email_login(client):
    signup(client)
    r = client.post("/auth/login", json={"email": "asha@example.com", "password": STRONG_PASSWORD})
    assert r.status_code == 401


def test_older_account_claims_a_number_and_then_signs_in_with_it(client, customer):
    cid = verified_challenge(client, "9811111111", "claim")
    r = client.post("/auth/number/claim", json={"challenge_id": cid, "passcode": PASSCODE}, headers=customer["headers"])
    assert r.status_code == 200 and r.json()["mobile"] == "9811111111"
    s = signin(client, "9811111111")
    assert s.status_code == 200
    me = client.get("/users/me", headers={"Authorization": f"Bearer {s.json()['access_token']}"}).json()
    assert me["id"] == customer["id"] and me["email"] == customer["email"]  # the same account, nothing lost


def test_claiming_needs_a_session(client):
    cid = verified_challenge(client, "9811111111", "claim")
    assert client.post("/auth/number/claim", json={"challenge_id": cid, "passcode": PASSCODE}).status_code == 401


def test_claim_cannot_take_a_number_someone_has(client, customer):
    signup(client)  # NUM belongs to Asha
    r = otp(client, NUM, "claim")
    assert r.status_code == 409


def test_account_with_a_number_cannot_claim_a_second(client, customer):
    cid = verified_challenge(client, "9811111111", "claim")
    assert client.post("/auth/number/claim", json={"challenge_id": cid, "passcode": PASSCODE}, headers=customer["headers"]).status_code == 200
    db_cid = verified_challenge(client, "9822222222", "claim")
    r = client.post("/auth/number/claim", json={"challenge_id": db_cid, "passcode": PASSCODE}, headers=customer["headers"])
    assert r.status_code == 409


def test_older_merchant_can_claim_a_number(client):
    email = unique_email("shop")
    client.post("/auth/merchant/register", json={"name": "S", "email": email, "business_name": "Shop", "password": STRONG_PASSWORD})
    tok = client.post("/auth/merchant/login", json={"email": email, "password": STRONG_PASSWORD}).json()["access_token"]
    cid = verified_challenge(client, "9833333333", "claim")
    r = client.post("/auth/number/claim", json={"challenge_id": cid, "passcode": PASSCODE}, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200
    assert signin(client, "9833333333").json()["role"] == "merchant"


def test_number_cannot_be_claimed_by_two_accounts_at_once(client, customer, db):
    """The registry primary key decides, even if both hold a verified code for the same number."""
    other_email = unique_email("o")
    client.post("/auth/register", json={"name": "O", "email": other_email, "password": STRONG_PASSWORD})
    other = client.post("/auth/login", json={"email": other_email, "password": STRONG_PASSWORD}).json()["access_token"]
    first = verified_challenge(client, "9844444444", "claim")
    db.execute(text("UPDATE otp_challenges SET created_at = created_at - interval '1 minute'"))
    db.commit()
    second = verified_challenge(client, "9844444444", "claim")
    a = client.post("/auth/number/claim", json={"challenge_id": first, "passcode": PASSCODE}, headers=customer["headers"])
    b = client.post("/auth/number/claim", json={"challenge_id": second, "passcode": PASSCODE}, headers={"Authorization": f"Bearer {other}"})
    assert sorted([a.status_code, b.status_code]) == [200, 409]


# ---- admin by number -------------------------------------------------------------------------------------------------------


def test_admin_can_be_made_from_a_number_and_signs_in_as_admin(client, db):
    from app import cli

    signup(client)
    assert cli._set_role(NUM, "admin") == 0
    r = signin(client)
    assert r.json()["role"] == "admin"
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/admin/ml/overview", headers=headers).status_code == 200


def test_create_admin_still_accepts_an_email(client, customer):
    from app import cli

    assert cli._set_role(customer["email"], "admin") == 0
    assert cli._set_role("nobody@example.com", "admin") == 1
    assert cli._set_role("9000000009", "admin") == 1


# ---- migration -------------------------------------------------------------------------------------------------------------


def test_downgrade_refuses_while_number_only_accounts_exist(client):
    import os

    from alembic import command
    from alembic.config import Config

    signup(client)
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    with pytest.raises(Exception, match="no email"):
        command.downgrade(cfg, "0011")
    # And with those accounts gone it is a clean, reversible step.
    from app.database.session import engine

    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE users, merchants RESTART IDENTITY CASCADE"))
    command.downgrade(cfg, "0011")
    command.upgrade(cfg, "head")
