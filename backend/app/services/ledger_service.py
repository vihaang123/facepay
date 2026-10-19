"""The historical simulated ledger.

FacePay no longer keeps a wallet: a payment is made from a (simulated) connected bank account and recorded as a
`Transaction` row, which is the source of truth. Nothing writes ledger entries or changes `users.balance` /
`merchants.balance` any more.

The table and the old balance columns stay in the database so that payments made under the previous wallet design keep
their history. `reconcile` still proves that those old balances equal their ledger entries (it reports nothing for an
account that has no entries and a zero balance, which is every account created since).
"""

from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import LedgerEntry, Merchant, User


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
