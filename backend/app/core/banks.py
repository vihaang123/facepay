"""The curated list of Indian banks offered in the DEMO "Connect your bank" flow.

Names only, plus an accent colour for a text monogram. No logos or trademarks are used and nothing here implies that any
bank has endorsed, partnered with or even knows about FacePay. Choosing a bank creates a simulated record in FacePay's own
database; no bank is contacted and no credentials are ever requested.
"""

DEMO_DISCLAIMER = "Demo connection only. No real bank account is accessed and no money is transferred."

# code, display name, short monogram, accent colour (for the monogram badge only)
_BANKS = [
    ("sbi", "State Bank of India", "SBI", "#1d4f91"),
    ("hdfc", "HDFC Bank", "HDFC", "#0b3d7a"),
    ("icici", "ICICI Bank", "ICICI", "#b34a1a"),
    ("axis", "Axis Bank", "AXIS", "#8a1f3d"),
    ("kotak", "Kotak Mahindra Bank", "KMB", "#b3261e"),
    ("pnb", "Punjab National Bank", "PNB", "#8c2a1c"),
    ("bob", "Bank of Baroda", "BoB", "#bd5418"),
    ("canara", "Canara Bank", "CB", "#1a6d8a"),
    ("union", "Union Bank of India", "UBI", "#1c5fa8"),
    ("idfc", "IDFC FIRST Bank", "IDFC", "#8a1538"),
    ("indusind", "IndusInd Bank", "IIB", "#7a1e3a"),
    ("yes", "Yes Bank", "YES", "#1b5aa6"),
    ("federal", "Federal Bank", "FED", "#1f6f8b"),
    ("boi", "Bank of India", "BOI", "#1f4f8f"),
    ("indian", "Indian Bank", "IB", "#1a5c94"),
]

BANKS: dict[str, dict] = {code: {"code": code, "name": name, "short": short, "color": color} for code, name, short, color in _BANKS}

# Account types a discovery provider may report for a linked account (the customer no longer picks one).
ACCOUNT_TYPES: dict[str, str] = {"SAVINGS": "Savings account", "SALARY": "Salary account", "CURRENT": "Current account"}

MAX_CONNECTED_BANKS = 5


def catalog() -> list[dict]:
    return list(BANKS.values())
