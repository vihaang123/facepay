"""The UPI-style parts of a payment: a 12-digit reference number, the step trail, and the simulated bank behaviours.

Everything here is a SIMULATION. "UTR" is only a familiar name for a reference number: FacePay is not connected to NPCI, UPI or any
bank, and the trail describes what FacePay's own simulation did, in order. Nothing in a trail is invented: each step is derived from
fields the server stored (the transaction's status, failure code and copied bank details).
"""

import secrets

BEHAVIORS: dict[str, str] = {
    "NORMAL": "Works normally",
    "DECLINE": "Declines payments",
    "TIMEOUT": "Does not respond",
}
BEHAVIOR_NOTE = "Demo setting. It only changes what this simulated account does when you pay; no real bank is involved."

# failure_code -> (what the customer is told, what the trail step says; {bank} is filled in for the payer only)
FAILURES: dict[str, tuple[str, str]] = {
    "BANK_DECLINED": (
        "Your bank declined this payment (simulated). No money moved. Verify your face to try again, or choose another bank account.",
        "{bank} declined the payment (simulated)",
    ),
    "BANK_TIMEOUT": (
        "Your bank did not respond (simulated). No money moved. Verify your face to try again, or choose another bank account.",
        "{bank} did not respond (simulated)",
    ),
}

_UTR_DIGITS = 12


def new_utr() -> str:
    """12 random digits, never starting with 0. Random, and not modelled on any real network's numbering."""
    return str(secrets.randbelow(9 * 10 ** (_UTR_DIGITS - 1)) + 10 ** (_UTR_DIGITS - 1))


def failure_message(code: str | None) -> str | None:
    return FAILURES[code][0] if code in FAILURES else None


def build_trail(*, status: str, failure_code: str | None, viewer_is_payer: bool, bank_label: str | None, payee_name: str | None) -> list[dict]:
    """Ordered steps, each {key, label, state}. state is done | failed | skipped. Only the payer is told which of their own
    demo accounts was used; everyone else sees a generic "payer's bank"."""
    bank = bank_label if (viewer_is_payer and bank_label) else "Payer's bank"
    who = payee_name or "the receiver"
    steps = [
        {"key": "face", "label": "Face verified", "state": "done"},
        {"key": "confirm", "label": "Payment confirmed", "state": "done"},
    ]
    if status == "SUCCESS":
        steps += [
            {"key": "debit", "label": f"{bank}: debit approved (simulated)", "state": "done"},
            {"key": "credit", "label": f"{who} credited (simulated)", "state": "done"},
            {"key": "complete", "label": "Payment complete", "state": "done"},
        ]
    elif status == "FAILED":
        reason = FAILURES.get(failure_code or "", (None, "{bank} could not complete the payment (simulated)"))[1].format(bank=bank)
        steps += [
            {"key": "debit", "label": reason, "state": "failed"},
            {"key": "credit", "label": f"{who} was not credited", "state": "skipped"},
            {"key": "complete", "label": "No money moved", "state": "skipped"},
        ]
    else:  # PENDING: nothing in the app creates one, but a receipt must still be honest about it
        steps += [{"key": "debit", "label": f"{bank}: waiting (simulated)", "state": "skipped"}]
    return steps
