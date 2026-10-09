"""The simulated ledger. Money here is fictional; the rules are the point.

* Amounts are Decimal in NUMERIC(12,2). No floating point anywhere.
* A balance changes only inside `post_payment` / `grant_opening_balance`, which also write the ledger entries, in the
  caller's database transaction. Either everything commits (debit, credit, transaction row) or nothing does.
* Accounts are row-locked (FOR UPDATE) in a fixed order - customers by ascending id, then the merchant - so two
  payments touching the same accounts serialize and can never deadlock each other.
* Balances cannot go negative: checked here and backed by a CHECK constraint in PostgreSQL.
* Every debit has a credit of the same amount (a transfer or merchant payment), or is an OPENING_GRANT (credit only).
  `reconcile` proves that balances equal their ledger entries.
"""

from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import LedgerEntry, Merchant, Transaction, User

CENT = Decimal("0.01")


def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def insufficient(balance: Decimal) -> HTTPException:
    return _err(409, "INSUFFICIENT_BALANCE", f"Not enough simulated balance. You have ₹{balance:,.2f}.")


def lock_users(db: Session, *user_ids: int) -> dict[int, User]:
    """Row-locks the customers in ascending id order and returns them keyed by id (fresh values, not cached ones)."""
    rows = db.scalars(
        select(User).where(User.id.in_(set(user_ids))).order_by(User.id).with_for_update().execution_options(populate_existing=True)
    )
    return {u.id: u for u in rows}


def lock_merchant(db: Session, merchant_id: int) -> Merchant:
    return db.scalar(select(Merchant).where(Merchant.id == merchant_id).with_for_update().execution_options(populate_existing=True))


def _entry(db: Session, *, txn_id: int | None, account_type: str, account_id: int, direction: str, amount: Decimal, balance_after: Decimal, kind: str):
    db.add(
        LedgerEntry(
            transaction_id=txn_id, account_type=account_type, account_id=account_id, direction=direction,
            amount=amount, balance_after=balance_after, kind=kind,
        )
    )


def grant_opening_balance(db: Session, user: User, amount: Decimal) -> None:
    """The one-off simulated starting balance, recorded like any other movement (caller commits)."""
    if amount <= 0:
        return
    user.balance = (user.balance or Decimal("0")) + amount
    db.flush()
    _entry(db, txn_id=None, account_type="USER", account_id=user.id, direction="CREDIT", amount=amount, balance_after=user.balance, kind="OPENING_GRANT")


def post_payment(db: Session, txn: Transaction, *, payer_id: int, recipient_user_id: int | None = None, merchant_id: int | None = None) -> Decimal:
    """Moves txn.amount from the payer to a customer or a merchant and writes both ledger entries. `txn` must already
    be flushed (it needs an id). Returns the payer's balance afterwards. Raises INSUFFICIENT_BALANCE without changing
    anything. The caller commits."""
    if (recipient_user_id is None) == (merchant_id is None):
        raise ValueError("exactly one of recipient_user_id and merchant_id")
    amount = txn.amount
    if amount <= 0:
        raise _err(422, "INVALID_AMOUNT", "The amount must be greater than zero.")

    ids = [payer_id] + ([recipient_user_id] if recipient_user_id is not None else [])
    users = lock_users(db, *ids)
    payer = users[payer_id]
    merchant = lock_merchant(db, merchant_id) if merchant_id is not None else None
    if payer.balance < amount:
        raise insufficient(payer.balance)

    kind = "TRANSFER" if recipient_user_id is not None else "MERCHANT_PAYMENT"
    payer.balance = payer.balance - amount
    if recipient_user_id is not None:
        payee = users[recipient_user_id]
        payee.balance = payee.balance + amount
        credit = ("USER", payee.id, payee.balance)
    else:
        merchant.balance = merchant.balance + amount
        credit = ("MERCHANT", merchant.id, merchant.balance)
    db.flush()  # the CHECK constraints run here: a negative balance can never be committed
    _entry(db, txn_id=txn.id, account_type="USER", account_id=payer.id, direction="DEBIT", amount=amount, balance_after=payer.balance, kind=kind)
    _entry(db, txn_id=txn.id, account_type=credit[0], account_id=credit[1], direction="CREDIT", amount=amount, balance_after=credit[2], kind=kind)
    return payer.balance


def wallet(db: Session, user: User, limit: int = 10) -> dict:
    rows = db.scalars(
        select(LedgerEntry).where(LedgerEntry.account_type == "USER", LedgerEntry.account_id == user.id).order_by(LedgerEntry.id.desc()).limit(limit)
    )
    return {
        "balance": user.balance,
        "currency": "INR",
        "simulated": True,
        "entries": [
            {"direction": e.direction, "amount": e.amount, "balance_after": e.balance_after, "kind": e.kind, "created_at": e.created_at}
            for e in rows
        ],
    }


# ------------------------------------------------------------------ integrity check


def reconcile(db: Session) -> list[str]:
    """Problems found (empty list = the ledger is consistent):
    * an account whose balance differs from credits minus debits
    * a transaction whose debit and credit amounts differ, or that is missing one side
    """
    problems: list[str] = []
    signed = func.coalesce(func.sum(case((LedgerEntry.direction == "CREDIT", LedgerEntry.amount), else_=-LedgerEntry.amount)), 0)
    for account_type, model in (("USER", User), ("MERCHANT", Merchant)):
        sums = dict(
            db.execute(select(LedgerEntry.account_id, signed).where(LedgerEntry.account_type == account_type).group_by(LedgerEntry.account_id)).all()
        )
        for account_id, balance in db.execute(select(model.id, model.balance)):
            expected = sums.get(account_id, Decimal("0"))
            if balance != expected:
                problems.append(f"{account_type} {account_id}: balance {balance} but ledger says {expected}")
    pairs = db.execute(
        select(
            LedgerEntry.transaction_id,
            func.count().filter(LedgerEntry.direction == "DEBIT"),
            func.count().filter(LedgerEntry.direction == "CREDIT"),
            func.coalesce(func.sum(LedgerEntry.amount).filter(LedgerEntry.direction == "DEBIT"), 0),
            func.coalesce(func.sum(LedgerEntry.amount).filter(LedgerEntry.direction == "CREDIT"), 0),
        )
        .where(LedgerEntry.transaction_id.is_not(None))
        .group_by(LedgerEntry.transaction_id)
    )
    for txn_id, debits, credits, debit_sum, credit_sum in pairs:
        if debits != 1 or credits != 1 or debit_sum != credit_sum:
            problems.append(f"transaction {txn_id}: {debits} debit(s) {debit_sum}, {credits} credit(s) {credit_sum}")
    return problems
