"""Why money is being asked for. Every request made to another customer states a purpose (a fixed category) and a reference
(a short sentence). The two exist to make scams harder: a request with no reason, a nonsense reason, or a reason that is a
well-known scam script is refused before the other person ever sees it, and the person asked always sees both.
"""

import re

PURPOSES = {
    "GOODS": "Goods or shopping",
    "SERVICE": "Service or work done",
    "BILL_SPLIT": "Splitting a bill",
    "REPAYMENT": "Repaying money lent",
    "RENT": "Rent or deposit",
    "OTHER": "Something else",
}

MIN_REFERENCE_CHARS = 3
MAX_REFERENCE_CHARS = 80

# Phrases that appear in money scams: nobody legitimately asks for money "for" these. Deliberately short and literal; this is a
# guard rail for a prototype, not fraud detection.
_SCAM = re.compile(
    r"\b(otp|cvv|upi\s*pin|atm\s*pin|password|lottery|lucky\s*draw|prize|gift\s*card|crypto|investment\s*return|kyc\s*update)\b",
    re.IGNORECASE,
)


def purpose_label(code: str | None) -> str | None:
    return PURPOSES.get(code) if code else None


def clean_reference(value: str) -> str:
    """The reference tidied up, or ValueError with a message the person can act on."""
    text = " ".join((value or "").split())
    if not text:
        raise ValueError("Say what this is for, for example “Order #14 groceries”.")
    if len(text) < MIN_REFERENCE_CHARS:
        raise ValueError("The reference is too short. Say what this is for in a few words.")
    if len(text) > MAX_REFERENCE_CHARS:
        raise ValueError(f"Keep the reference to {MAX_REFERENCE_CHARS} characters or fewer.")
    letters = [c.lower() for c in text if c.isalpha()]
    if len(letters) < 3 or len(set(letters)) < 2:
        raise ValueError("Write a real reason in words, for example “Dinner split, Friday”.")
    if _SCAM.search(text):
        raise ValueError("Do not ask for money for OTPs, PINs, passwords, prizes or gift cards. Describe the real reason.")
    return text


def clean_purpose(value: str) -> str:
    if value not in PURPOSES:
        raise ValueError("Choose what the money is for.")
    return value
