"""Face-first payments: simulated bank connections as funding sources, funding source on transactions, counter display

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-19 12:00:00

What changes and why:
* bank_connections: a customer's simulated ("demo") linked bank accounts. It holds NO credentials, no real account
  number and no balance: only the bank name, an account type and four random digits shown as DEMO-••••-1234.
  Exactly one connected account per customer can be the default (partial unique index).
* transactions.funding_source_id / funding_bank_name / funding_account_ref: which demo account a payment was made from.
  The name and reference are copied onto the transaction so a receipt stays correct after the account is disconnected.
* payment_sessions.discoverable: a merchant chose to display this payment request in the simulated "nearby" list.

Backward compatible: every new column is nullable or has a server default, and nothing is deleted. users.balance,
merchants.balance and ledger_entries stay in place (history is not rewritten) but new payments no longer use them.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "bank_connections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("connection_id", sa.String(40), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("bank_code", sa.String(24), nullable=False),
        sa.Column("bank_name", sa.String(80), nullable=False),
        sa.Column("account_type", sa.String(20), nullable=False),
        sa.Column("account_last4", sa.String(4), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("status", sa.String(16), nullable=False, server_default="CONNECTED"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("disconnected_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("status IN ('CONNECTED', 'DISCONNECTED')", name="ck_bank_connections_status"),
        sa.CheckConstraint("account_type IN ('SAVINGS', 'SALARY', 'CURRENT')", name="ck_bank_connections_type"),
        sa.CheckConstraint("account_last4 ~ '^[0-9]{4}$'", name="ck_bank_connections_last4"),
        sa.CheckConstraint("NOT is_default OR status = 'CONNECTED'", name="ck_bank_connections_default_connected"),
    )
    op.create_index("ix_bank_connections_connection_id", "bank_connections", ["connection_id"], unique=True)
    op.create_index("ix_bank_connections_user_status", "bank_connections", ["user_id", "status"])
    # One default per customer, and one live connection per (customer, bank, account type).
    op.create_index(
        "uq_bank_connections_one_default", "bank_connections", ["user_id"], unique=True,
        postgresql_where=sa.text("is_default AND status = 'CONNECTED'"),
    )
    op.create_index(
        "uq_bank_connections_live_account", "bank_connections", ["user_id", "bank_code", "account_type"], unique=True,
        postgresql_where=sa.text("status = 'CONNECTED'"),
    )

    op.add_column("transactions", sa.Column("funding_source_id", sa.Integer(), sa.ForeignKey("bank_connections.id", name="fk_transactions_funding_source")))
    op.add_column("transactions", sa.Column("funding_bank_name", sa.String(80)))
    op.add_column("transactions", sa.Column("funding_account_ref", sa.String(24)))
    op.add_column("payment_sessions", sa.Column("discoverable", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("payment_sessions", "discoverable")
    op.drop_column("transactions", "funding_account_ref")
    op.drop_column("transactions", "funding_bank_name")
    op.drop_constraint("fk_transactions_funding_source", "transactions", type_="foreignkey")
    op.drop_column("transactions", "funding_source_id")
    op.drop_table("bank_connections")
