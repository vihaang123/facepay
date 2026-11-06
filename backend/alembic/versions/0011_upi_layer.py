"""UPI-style layer: transaction reference number, failure code, simulated bank behaviour

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-06 14:30:00

transactions.utr is a random unique 12-digit reference. Existing rows are backfilled so history shows one too.
transactions.failure_code says why a FAILED transaction failed. bank_connections.sim_behavior is the owner's demo switch for how a
simulated account answers a payment. Nothing is deleted; downgrade drops the three columns.
"""
import secrets
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0011'
down_revision: Union[str, Sequence[str], None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _utr() -> str:
    return str(secrets.randbelow(9 * 10**11) + 10**11)


def upgrade() -> None:
    op.add_column("transactions", sa.Column("utr", sa.String(12), nullable=True))
    op.add_column("transactions", sa.Column("failure_code", sa.String(30), nullable=True))
    conn = op.get_bind()
    used: set[str] = set()
    for (pk,) in conn.execute(sa.text("SELECT id FROM transactions WHERE utr IS NULL ORDER BY id")).fetchall():
        value = _utr()
        while value in used:
            value = _utr()
        used.add(value)
        conn.execute(sa.text("UPDATE transactions SET utr = :u WHERE id = :i"), {"u": value, "i": pk})
    op.create_index("ix_transactions_utr", "transactions", ["utr"], unique=True)
    op.add_column("bank_connections", sa.Column("sim_behavior", sa.String(12), server_default="NORMAL", nullable=False))
    op.create_check_constraint("ck_bank_connections_behavior", "bank_connections", "sim_behavior IN ('NORMAL', 'DECLINE', 'TIMEOUT')")


def downgrade() -> None:
    op.drop_constraint("ck_bank_connections_behavior", "bank_connections", type_="check")
    op.drop_column("bank_connections", "sim_behavior")
    op.drop_index("ix_transactions_utr", table_name="transactions")
    op.drop_column("transactions", "failure_code")
    op.drop_column("transactions", "utr")
