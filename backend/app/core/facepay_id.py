"""FacePay ID: the one canonical, human-readable payment identifier inside this simulated payment ecosystem.

Canonical form:  <handle>@facepay   e.g. vihaan@facepay

* handle: 3 to 24 characters, lowercase ASCII letters and digits, with single dots or underscores between them.
  It starts and ends with a letter or digit. Anything outside ASCII is refused (no look-alike characters).
* The domain part is always `facepay`. A bare handle is accepted as input and completed to the canonical form.
* Everything is normalised here, on the server, before a lookup or a uniqueness check.

This is NOT a UPI ID and has no relation to any bank or payment network.
"""

import re
import secrets
import unicodedata

DOMAIN = "facepay"
SUFFIX = "@" + DOMAIN
MIN_HANDLE, MAX_HANDLE = 3, 24

# letters/digits, optionally joined by ONE dot or underscore at a time
_HANDLE_RE = re.compile(r"^[a-z0-9]+(?:[._][a-z0-9]+)*$")

# Handles nobody may take, so no one can pose as the service or its staff.
RESERVED = frozenset(
    {
        "admin", "administrator", "root", "support", "help", "service", "security", "official", "facepay", "face.pay",
        "billing", "payments", "payment", "merchant", "merchants", "system", "staff", "team", "info", "contact",
        "noreply", "no.reply", "null", "undefined", "test", "bank", "upi", "wallet", "refund", "refunds",
    }
)


class InvalidFacePayId(ValueError):
    """Carries a message that is safe to show to the customer."""


def normalize(raw: str) -> str:
    """Canonical `handle@facepay` or InvalidFacePayId. Case-insensitive; surrounding spaces ignored."""
    if not isinstance(raw, str):
        raise InvalidFacePayId("Enter a FacePay ID.")
    text = raw.strip().lower()
    if not text:
        raise InvalidFacePayId("Enter a FacePay ID.")
    if not text.isascii() or any(unicodedata.category(c).startswith("C") for c in text):
        raise InvalidFacePayId("A FacePay ID can only use letters, numbers, dots and underscores.")
    if "@" in text:
        handle, _, domain = text.partition("@")
        if domain != DOMAIN or "@" in handle:
            raise InvalidFacePayId("A FacePay ID looks like name@facepay.")
    else:
        handle = text
    validate_handle(handle)
    return handle + SUFFIX


def validate_handle(handle: str) -> None:
    if not MIN_HANDLE <= len(handle) <= MAX_HANDLE:
        raise InvalidFacePayId(f"The part before @facepay must be {MIN_HANDLE} to {MAX_HANDLE} characters.")
    if not _HANDLE_RE.match(handle):
        raise InvalidFacePayId("Use letters and numbers, with a single dot or underscore between them.")
    if handle in RESERVED:
        raise InvalidFacePayId("That name is reserved. Please choose another.")


def handle_of(facepay_id: str) -> str:
    return facepay_id.removesuffix(SUFFIX)


def mask(facepay_id: str) -> str:
    """vihaan@facepay -> vi***n@facepay. Enough to recognise your own recipient, not enough to harvest IDs."""
    handle = handle_of(facepay_id)
    if len(handle) <= 3:
        shown = handle[0] + "*" * (len(handle) - 1)
    else:
        shown = handle[:2] + "***" + handle[-1]
    return shown + SUFFIX


def slug_from_name(name: str) -> str:
    """First word of a display name as a handle stem ('Vihaan Gandhi' -> 'vihaan'). May be too short or reserved:
    the caller checks."""
    folded = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    first = re.sub(r"[^a-z0-9]", "", (folded.split() or [""])[0].lower())
    return first[:16]


def random_digits(n: int) -> str:
    return "".join(secrets.choice("0123456789") for _ in range(n))


def fallback_id() -> str:
    """Last-resort unique-ish ID, also the database default for rows created without the service."""
    return f"user{random_digits(10)}{SUFFIX}"
