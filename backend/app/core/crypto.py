"""Encryption at rest for biometric data: AES-256-GCM with a key from the environment.

Deliberately simple (academic prototype): one key, `BIOMETRIC_KEY` = 32 random bytes,
base64-encoded. No key rotation or KMS. Losing or changing the key makes stored biometric
data unreadable, which is the intended failure mode (users re-enroll).

Blob layout: 1 version byte | 12-byte random nonce | ciphertext+tag.
`context` is authenticated but not encrypted (e.g. "face_sample:7"), so a blob copied to
another row or purpose fails to decrypt.
"""

import base64
import binascii
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

_VERSION = b"\x01"
_NONCE_LEN = 12


class BiometricCryptoError(Exception):
    """Key missing/invalid, or a blob failed authentication."""


def generate_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def _key() -> bytes:
    raw = get_settings().biometric_key
    if not raw:
        raise BiometricCryptoError("BIOMETRIC_KEY is not configured")
    try:
        key = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BiometricCryptoError("BIOMETRIC_KEY is not valid base64") from exc
    if len(key) != 32:
        raise BiometricCryptoError("BIOMETRIC_KEY must decode to exactly 32 bytes")
    return key


def encrypt(plaintext: bytes, context: str) -> bytes:
    nonce = os.urandom(_NONCE_LEN)
    return _VERSION + nonce + AESGCM(_key()).encrypt(nonce, plaintext, context.encode())


def decrypt(blob: bytes, context: str) -> bytes:
    if len(blob) < 1 + _NONCE_LEN + 16 or blob[:1] != _VERSION:
        raise BiometricCryptoError("unrecognised biometric blob")
    nonce, body = blob[1 : 1 + _NONCE_LEN], blob[1 + _NONCE_LEN :]
    try:
        return AESGCM(_key()).decrypt(nonce, body, context.encode())
    except InvalidTag as exc:
        raise BiometricCryptoError("biometric blob failed authentication (wrong key or context)") from exc
