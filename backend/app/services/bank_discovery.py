"""Bank account discovery: given a customer and a bank they picked, find the account linked to them there.

This is the seam for a real integration. `BankDiscoveryProvider` is the whole contract. Today the only provider is
`SimulatedDiscoveryProvider`, which fabricates a deterministic demo record. An authorised bank or UPI account-discovery
integration would implement the same interface and be selected with BANK_DISCOVERY_PROVIDER; nothing else changes.

Rules every provider follows:
- Return only what the provider actually knows. A field it does not return is None, never a guess. The screens hide empty fields.
- Never ask the customer for, or pass on, a credential, a UPI PIN, a card detail, an Aadhaar number or a bank OTP.
- The account holder name comes from the provider's record. The client never supplies it.
"""

import hashlib
from dataclasses import dataclass
from typing import Protocol

from app.core import banks
from app.core.config import get_settings


class DiscoveryUnavailable(Exception):
    """The provider could not be reached or refused. Nothing is linked."""


class NoAccountFound(Exception):
    """The bank has no account linked to this customer."""


@dataclass(frozen=True)
class DiscoveryRequest:
    user_id: int
    bank_code: str
    bank_name: str
    mobile: str | None  # the customer's verified mobile number, when they have one (the key a real UPI lookup would use)
    customer_name: str  # the demo customer the simulated record belongs to; a real provider ignores it


@dataclass(frozen=True)
class DiscoveredAccount:
    holder_name: str
    account_type: str  # SAVINGS | SALARY | CURRENT
    account_last4: str  # only the last four digits ever leave the provider layer
    ifsc: str | None = None
    branch: str | None = None
    source: str = "SIMULATED"  # which provider produced the record, stored with it


class BankDiscoveryProvider(Protocol):
    name: str

    def discover(self, request: DiscoveryRequest) -> list[DiscoveredAccount]:
        """The accounts linked to this customer at this bank (possibly none). Raise DiscoveryUnavailable on failure."""


# Branch areas used by the simulator. "Demo Branch" is in every name so none can be mistaken for a real branch.
_AREAS = ["Fort, Mumbai", "Connaught Place, Delhi", "MG Road, Bengaluru", "Park Street, Kolkata", "Anna Salai, Chennai",
          "Banjara Hills, Hyderabad", "Law Garden, Ahmedabad", "FC Road, Pune"]


class SimulatedDiscoveryProvider:
    """A deterministic, synthetic bank record. The same customer and bank always give the same account, on every login
    and after every restart, because it is computed from (customer id, bank) and nothing random or time based.
    No bank is contacted. The IFSC starts DEMO0 so it can never be taken for a real one."""

    name = "SIMULATED"

    def discover(self, request: DiscoveryRequest) -> list[DiscoveredAccount]:
        digest = hashlib.sha256(f"facepay-demo-bank|{request.user_id}|{request.bank_code}".encode()).digest()
        number = int.from_bytes(digest[:8], "big")
        last4 = f"{number % 10000:04d}"
        account_type = ("SAVINGS", "SAVINGS", "SAVINGS", "SALARY")[digest[8] % 4]  # most demo accounts are plain savings
        area = _AREAS[digest[9] % len(_AREAS)]
        ifsc = "DEMO0" + f"{int.from_bytes(digest[10:14], 'big') % 1_000_000:06d}"
        return [
            DiscoveredAccount(
                # Banks hold names in capitals; this is the customer's registered demo name as the simulated record shows it.
                holder_name=" ".join(request.customer_name.split()).upper(),
                account_type=account_type,
                account_last4=last4,
                ifsc=ifsc,
                branch=f"Demo Branch, {area}",
                source=self.name,
            )
        ]


_PROVIDERS: dict[str, BankDiscoveryProvider] = {"simulated": SimulatedDiscoveryProvider()}


def get_provider() -> BankDiscoveryProvider:
    key = get_settings().bank_discovery_provider.strip().lower()
    provider = _PROVIDERS.get(key)
    if provider is None:
        # An unknown or unconfigured provider must fail visibly rather than quietly fall back to made-up data.
        raise DiscoveryUnavailable(f"Bank account discovery provider '{key}' is not configured.")
    return provider


def register_provider(key: str, provider: BankDiscoveryProvider) -> None:
    """How a real integration plugs in (and how tests substitute one)."""
    _PROVIDERS[key.strip().lower()] = provider


def validate(account: DiscoveredAccount) -> DiscoveredAccount:
    """A provider's answer is checked before it is stored: a malformed record is a failure, not something to patch up."""
    ok = (
        bool(account.holder_name.strip())
        and account.account_type in banks.ACCOUNT_TYPES
        and len(account.account_last4) == 4
        and account.account_last4.isdigit()
        and (account.ifsc is None or (len(account.ifsc) == 11 and account.ifsc[:4].isalpha() and account.ifsc[4] == "0"))
    )
    if not ok:
        raise DiscoveryUnavailable("The bank returned an account record that could not be used.")
    return account
