"""Operator commands. Run from the backend directory with the production environment variables set, for example in
the Render shell:

    python -m app.cli create-admin you@example.com     # promote an EXISTING customer account to administrator
    python -m app.cli remove-admin you@example.com     # back to an ordinary customer
    python -m app.cli reconcile-ledger                 # check that every balance equals its ledger entries
    python -m app.cli retrain-model                    # rebuild the face model from the stored samples (no new capture)

Nothing here is reachable over HTTP: there is deliberately no endpoint that grants a role.
"""

import sys

from sqlalchemy import select

from app.database.session import SessionLocal
from app.models import User
from app.core import mobile as mobile_rules
from app.services import ledger_service, number_auth_service


def _set_role(who: str, role: str) -> int:
    """`who` is the account's email, or its 10-digit mobile number."""
    with SessionLocal() as db:
        try:
            owner = number_auth_service.owner_of(db, mobile_rules.normalize(who))
            user = owner if isinstance(owner, User) else None
        except mobile_rules.InvalidMobile:
            user = db.scalar(select(User).where(User.email == who.strip().lower()))
        if user is None:
            print("No customer account with that email or mobile number. Register it first, then run this again.")
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
    if argv == ["retrain-model"]:
        from app.services import face_service

        with SessionLocal() as db:
            if face_service.retrain_if_outdated(db):
                print("The face model was retrained from the stored samples.")
            else:
                print("Nothing to do: the model is already current, or fewer than 2 people have a finished face setup.")
        return 0
    print(__doc__)
    return 64


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
