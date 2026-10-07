import time
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.core.config import get_settings
from app.core.security import (
    TokenError,
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


def test_hash_is_not_plaintext_and_is_argon2id():
    h = hash_password("Correct-horse-42")
    assert "Correct-horse-42" not in h
    assert h.startswith("$argon2id$")


def test_same_password_gets_different_hashes():
    assert hash_password("Correct-horse-42") != hash_password("Correct-horse-42")


def test_verify_password_accepts_right_and_rejects_wrong():
    h = hash_password("Correct-horse-42")
    assert verify_password("Correct-horse-42", h) is True
    assert verify_password("correct-horse-42", h) is False
    assert verify_password("", h) is False


def test_verify_with_no_hash_is_always_false():
    assert verify_password("anything", None) is False
    # even the password the dummy hash was built from must not pass
    assert verify_password("facepay-dummy-password-for-timing", None) is False


def test_verify_with_garbage_hash_is_false_not_an_error():
    assert verify_password("x", "not-a-real-hash") is False


def test_token_round_trip():
    token, expires_in = create_access_token(42, "customer")
    claims = decode_access_token(token)
    assert claims["sub"] == "42"
    assert claims["role"] == "customer"
    assert claims["type"] == "access"
    assert expires_in == get_settings().jwt_expire_minutes * 60


def _forge(payload: dict, secret: str | None = None, alg: str = "HS256") -> str:
    s = get_settings()
    return jwt.encode(payload, secret or s.jwt_secret, algorithm=alg)


def _payload(**overrides) -> dict:
    now = datetime.now(timezone.utc)
    base = {"sub": "1", "role": "customer", "type": "access", "iat": now, "exp": now + timedelta(minutes=5)}
    base.update(overrides)
    return base


def test_expired_token_rejected():
    token = _forge(_payload(exp=datetime.now(timezone.utc) - timedelta(seconds=5)))
    with pytest.raises(TokenError):
        decode_access_token(token)


def test_token_signed_with_wrong_secret_rejected():
    with pytest.raises(TokenError):
        decode_access_token(_forge(_payload(), secret="a-completely-different-secret-value"))


def test_tampered_token_rejected():
    token, _ = create_access_token(1, "customer")
    head, body, sig = token.split(".")
    tampered = ".".join([head, body[:-2] + ("AA" if not body.endswith("AA") else "BB"), sig])
    with pytest.raises(TokenError):
        decode_access_token(tampered)


def test_alg_none_token_rejected():
    unsigned = jwt.encode(_payload(), key=None, algorithm="none")
    with pytest.raises(TokenError):
        decode_access_token(unsigned)


def test_token_missing_required_claims_rejected():
    no_role = _payload()
    del no_role["role"]
    no_exp = _payload()
    del no_exp["exp"]
    for p in (no_role, no_exp):
        with pytest.raises(TokenError):
            decode_access_token(_forge(p))


def test_token_with_wrong_type_rejected():
    with pytest.raises(TokenError):
        decode_access_token(_forge(_payload(type="refresh")))


def test_garbage_token_rejected():
    for bad in ("", "abc", "a.b.c"):
        with pytest.raises(TokenError):
            decode_access_token(bad)


def test_rate_limiter_window_expires():
    from app.core.rate_limit import RateLimiter

    rl = RateLimiter(max_requests=2, window_seconds=0.2)
    assert rl.allow("k") and rl.allow("k")
    assert rl.allow("k") is False
    assert rl.allow("other") is True  # separate key is independent
    time.sleep(0.25)
    assert rl.allow("k") is True
