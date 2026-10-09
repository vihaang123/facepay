"""Operator commands. Run from the backend directory with the production environment variables set, for example in
the Render shell:

    python -m app.cli create-admin you@example.com     # promote an EXISTING customer account to administrator
    python -m app.cli remove-admin you@example.com     # back to an ordinary customer
    python -m app.cli reconcile-ledger                 # check that every balance equals its ledger entries

Nothing here is reachable over HTTP: there is deliberately no endpoint that grants a role.
"""

import sys

from sqlalchemy import select

from app.database.session import SessionLocal
from app.models import User
from app.services import ledger_service


def _set_role(email: str, role: str) -> int:
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email.strip().lower()))
        if user is None:
            print("No customer account with that email. Register it first, then run this again.")
            return 1
        user.role = role
        db.commit()
        print(f"Account {user.id} is now '{role}'. Existing sessions pick this up at the next sign-in.")
        return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "create-admin":
        return _set_role(argv[1], "admin")
    if len(argv) == 2 and argv[0] == "remove-admin":
        return _set_role(argv[1], "customer")
    if argv == ["reconcile-ledger"]:
        with SessionLocal() as db:
            problems = ledger_service.reconcile(db)
        print("Ledger is consistent." if not problems else "\n".join(problems))
        return 0 if not problems else 2
    print(__doc__)
    return 64


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
