"""Indian mobile numbers and app passcodes: validation only, no I/O.

A number is stored as its 10 national digits (starts 6 to 9). Anything people naturally type is accepted on the way in:
spaces, dashes, a +91 or 91 prefix, or a leading 0."""

import re

_TEN = re.compile(r"^[6-9][0-9]{9}$")
_WEAK = {"123456", "654321", "123123", "112233", "121212", "696969", "159753", "246810", "135790", "000000", "111111"}


class InvalidMobile(ValueError):
    pass


def normalize(raw: str | None) -> str:
    text = re.sub(r"[\s\-().]", "", raw or "")
    if text.startswith("+91"):
        text = text[3:]
    elif len(text) == 12 and text.startswith("91"):
        text = text[2:]
    elif len(text) == 11 and text.startswith("0"):
        text = text[1:]
    if not _TEN.match(text):
        raise InvalidMobile("Enter a valid 10-digit Indian mobile number.")
    return text


def mask(mobile: str) -> str:
    return f"+91 •••••{mobile[-5:]}"


def check_passcode(value: str | None) -> str:
    """Six digits, and not one of the guesses everybody tries first."""
    p = value or ""
    if not re.fullmatch(r"[0-9]{6}", p):
        raise ValueError("The passcode must be exactly 6 digits.")
    digits = [int(c) for c in p]
    steps = {digits[i + 1] - digits[i] for i in range(5)}
    if len(set(p)) == 1 or steps in ({1}, {-1}) or p in _WEAK or p[:3] == p[3:]:
        raise ValueError("Choose a passcode that is harder to guess (not 123456, 111111 or a repeating pattern).")
    return p
