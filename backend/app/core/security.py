"""Password hashing and JWT helpers. No secrets are logged or returned."""

from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

_hasher = PasswordHasher()  # Argon2id with library defaults

# Verified against when an email is unknown, so "no such user" and
# "wrong password" cost about the same time.
_DUMMY_HASH = _hasher.hash("facepay-dummy-password-for-timing")


class TokenError(Exception):
    """Raised for any invalid, expired or malformed token."""


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Constant-ish time check. Pass None to burn the same time as a real check."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def create_access_token(subject_id: int, role: str) -> tuple[str, int]:
    """Return (token, expires_in_seconds). `role` is customer, admin or merchant."""
    settings = get_settings()
    now = datetime.now(timezone.utc)
    expires = timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": str(subject_id),
        "role": role,
        "type": "access",
        "iat": now,
        "exp": now + expires,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, int(expires.total_seconds())


def decode_access_token(token: str) -> dict:
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],  # pinned: never trust the token's own alg
            options={"require": ["exp", "sub", "role"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError("Invalid or expired token") from exc
    if payload.get("type") != "access":
        raise TokenError("Invalid token type")
    return payload
