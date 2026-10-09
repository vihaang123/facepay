"""FacePay ID, simulated wallet and ledger, customer-to-customer transfers, money requests

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-09 14:00:00

Backward compatible with existing data:
* every existing customer gets a generated FacePay ID (derived from the first word of their name, de-duplicated);
* every existing customer receives the simulated opening balance as a single OPENING_GRANT ledger entry. Payments made
  before this migration predate the ledger and are NOT retro-debited, so history is not rewritten;
* existing merchant sessions and transactions keep their meaning (kind MERCHANT / MERCHANT_PAYMENT); the new columns
  are nullable or have server defaults. Nothing is deleted.
"""
import os
import re
import secrets
import unicodedata
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OPENING_BALANCE = os.environ.get("OPENING_BALANCE", "10000")
_RESERVED = {"admin", "administrator", "root", "support", "help", "service", "security", "official", "facepay",
             "billing", "payments", "payment", "merchant", "merchants", "system", "staff", "team", "info", "contact",
             "noreply", "null", "undefined", "test", "bank", "upi", "wallet", "refund", "refunds"}


def _stem(name: str) -> str:
    folded = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    first = re.sub(r"[^a-z0-9]", "", (folded.split() or [""])[0].lower())
    return first[:16]


def _digits(n: int) -> str:
    return "".join(secrets.choice("0123456789") for _ in range(n))


def _backfill_facepay_ids(bind) -> None:
    rows = bind.execute(sa.text("SELECT id, name FROM users ORDER BY id")).all()
    taken: set[str] = set()
    for user_id, name in rows:
        stem = _stem(name)
        candidate = stem if len(stem) >= 3 and stem not in _RESERVED else None
        n = 0
        while candidate is None or candidate in taken:
            n += 1
            base = stem if len(stem) >= 3 and stem not in _RESERVED else "user"
            candidate = base + _digits(min(2 + n // 3, 6))
        taken.add(candidate)
        bind.execute(sa.text("UPDATE users SET facepay_id = :f WHERE id = :i"), {"f": candidate + "@facepay", "i": user_id})


def upgrade() -> None:
    bind = op.get_bind()

    # ---- users: FacePay ID and simulated balance
    op.add_column('users', sa.Column('facepay_id', sa.String(length=40), nullable=True))
    op.add_column('users', sa.Column('facepay_id_changed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('balance', sa.Numeric(12, 2), server_default='0', nullable=False))
    _backfill_facepay_ids(bind)
    op.alter_column('users', 'facepay_id', nullable=False)
    op.create_index('ix_users_facepay_id', 'users', ['facepay_id'], unique=True)
    op.create_check_constraint('ck_users_facepay_id_format', 'users', "facepay_id ~ '^[a-z0-9]+([._][a-z0-9]+)*@facepay$'")
    op.create_check_constraint('ck_users_balance_non_negative', 'users', 'balance >= 0')

    op.add_column('merchants', sa.Column('balance', sa.Numeric(12, 2), server_default='0', nullable=False))
    op.create_check_constraint('ck_merchants_balance_non_negative', 'merchants', 'balance >= 0')

    op.create_table(
        'facepay_id_history',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('facepay_id', sa.String(length=40), nullable=False),
        sa.Column('retired_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('facepay_id'),
    )
    op.create_index('ix_facepay_id_history_user_id', 'facepay_id_history', ['user_id'])

    # ---- transactions: a transfer has a recipient instead of a merchant
    op.add_column('transactions', sa.Column('kind', sa.String(length=20), server_default='MERCHANT_PAYMENT', nullable=False))
    op.add_column('transactions', sa.Column('recipient_id', sa.Integer(), nullable=True))
    op.add_column('transactions', sa.Column('currency', sa.String(length=3), server_default='INR', nullable=False))
    op.add_column('transactions', sa.Column('note', sa.String(length=255), nullable=True))
    op.alter_column('transactions', 'merchant_id', nullable=True)
    op.create_foreign_key('fk_transactions_recipient', 'transactions', 'users', ['recipient_id'], ['id'])
    op.create_check_constraint(
        'ck_transactions_shape', 'transactions',
        "(kind = 'MERCHANT_PAYMENT' AND merchant_id IS NOT NULL AND recipient_id IS NULL)"
        " OR (kind = 'TRANSFER' AND merchant_id IS NULL AND recipient_id IS NOT NULL AND recipient_id <> payer_id)",
    )
    op.create_index('ix_transactions_recipient_ts', 'transactions', ['recipient_id', 'timestamp'])

    # ---- money requests (before payment_sessions, which reference them)
    op.create_table(
        'payment_requests',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('request_id', sa.String(length=40), nullable=False),
        sa.Column('requester_id', sa.Integer(), nullable=False),
        sa.Column('payer_id', sa.Integer(), nullable=False),
        sa.Column('amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('currency', sa.String(length=3), server_default='INR', nullable=False),
        sa.Column('note', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=20), server_default='PENDING', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('transaction_id', sa.Integer(), nullable=True),
        sa.CheckConstraint('amount > 0', name='ck_payment_requests_amount_positive'),
        sa.CheckConstraint('requester_id <> payer_id', name='ck_payment_requests_not_self'),
        sa.CheckConstraint("status IN ('PENDING', 'PAID', 'DECLINED', 'CANCELLED', 'EXPIRED')", name='ck_payment_requests_status'),
        sa.ForeignKeyConstraint(['requester_id'], ['users.id']),
        sa.ForeignKeyConstraint(['payer_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_foreign_key('fk_payment_requests_transaction', 'payment_requests', 'transactions', ['transaction_id'], ['id'])
    op.create_index('ix_payment_requests_request_id', 'payment_requests', ['request_id'], unique=True)
    op.create_index('ix_payment_requests_payer_status', 'payment_requests', ['payer_id', 'status'])
    op.create_index('ix_payment_requests_requester_created', 'payment_requests', ['requester_id', 'created_at'])

    # ---- payment sessions: MERCHANT (as before) or TRANSFER
    op.add_column('payment_sessions', sa.Column('kind', sa.String(length=20), server_default='MERCHANT', nullable=False))
    op.add_column('payment_sessions', sa.Column('payer_user_id', sa.Integer(), nullable=True))
    op.add_column('payment_sessions', sa.Column('payee_user_id', sa.Integer(), nullable=True))
    op.add_column('payment_sessions', sa.Column('payment_request_id', sa.Integer(), nullable=True))
    op.add_column('payment_sessions', sa.Column('idempotency_key', sa.String(length=64), nullable=True))
    op.alter_column('payment_sessions', 'merchant_id', nullable=True)
    op.create_foreign_key('fk_payment_sessions_payer', 'payment_sessions', 'users', ['payer_user_id'], ['id'])
    op.create_foreign_key('fk_payment_sessions_payee', 'payment_sessions', 'users', ['payee_user_id'], ['id'])
    op.create_foreign_key('fk_payment_sessions_request', 'payment_sessions', 'payment_requests', ['payment_request_id'], ['id'])
    op.create_check_constraint(
        'ck_payment_sessions_shape', 'payment_sessions',
        "(kind = 'MERCHANT' AND merchant_id IS NOT NULL AND payee_user_id IS NULL AND payment_request_id IS NULL)"
        " OR (kind = 'TRANSFER' AND merchant_id IS NULL AND payee_user_id IS NOT NULL AND payer_user_id IS NOT NULL"
        " AND payee_user_id <> payer_user_id)",
    )
    op.create_index('ix_payment_sessions_payer', 'payment_sessions', ['payer_user_id', 'created_at'])
    op.create_index(
        'uq_payment_sessions_one_open_per_request', 'payment_sessions', ['payment_request_id'], unique=True,
        postgresql_where=sa.text("payment_request_id IS NOT NULL AND status IN ('CREATED', 'AUTHENTICATED')"),
    )
    op.create_index(
        'uq_payment_sessions_idempotency', 'payment_sessions', ['payer_user_id', 'idempotency_key'], unique=True,
        postgresql_where=sa.text('idempotency_key IS NOT NULL'),
    )

    # ---- authorization snapshot gains the recipient of a transfer
    op.add_column('payment_authorizations', sa.Column('payee_user_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_payment_authorizations_payee', 'payment_authorizations', 'users', ['payee_user_id'], ['id'])

    # ---- ledger
    op.create_table(
        'ledger_entries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('transaction_id', sa.Integer(), nullable=True),
        sa.Column('account_type', sa.String(length=10), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=False),
        sa.Column('direction', sa.String(length=6), nullable=False),
        sa.Column('amount', sa.Numeric(12, 2), nullable=False),
        sa.Column('balance_after', sa.Numeric(12, 2), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('amount > 0', name='ck_ledger_entries_amount_positive'),
        sa.CheckConstraint("account_type IN ('USER', 'MERCHANT')", name='ck_ledger_entries_account_type'),
        sa.CheckConstraint("direction IN ('DEBIT', 'CREDIT')", name='ck_ledger_entries_direction'),
        sa.CheckConstraint("kind IN ('TRANSFER', 'MERCHANT_PAYMENT', 'OPENING_GRANT')", name='ck_ledger_entries_kind'),
        sa.ForeignKeyConstraint(['transaction_id'], ['transactions.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ledger_entries_account', 'ledger_entries', ['account_type', 'account_id', 'id'])
    op.create_index('ix_ledger_entries_transaction', 'ledger_entries', ['transaction_id'])

    # Opening balance for the customers that already exist (one entry each, so balance == credits - debits holds).
    bind.execute(sa.text("UPDATE users SET balance = :b"), {"b": OPENING_BALANCE})
    bind.execute(
        sa.text(
            "INSERT INTO ledger_entries (account_type, account_id, direction, amount, balance_after, kind) "
            "SELECT 'USER', id, 'CREDIT', :b, :b, 'OPENING_GRANT' FROM users"
        ),
        {"b": OPENING_BALANCE},
    )


def downgrade() -> None:
    """Development and test use only. Rows created by the new features (transfers, requests, ledger) are removed."""
    bind = op.get_bind()
    op.drop_index('ix_ledger_entries_transaction', table_name='ledger_entries')
    op.drop_index('ix_ledger_entries_account', table_name='ledger_entries')
    op.drop_table('ledger_entries')

    op.drop_constraint('fk_payment_authorizations_payee', 'payment_authorizations', type_='foreignkey')
    op.drop_column('payment_authorizations', 'payee_user_id')

    bind.execute(sa.text("DELETE FROM payment_authorizations WHERE payment_session_id IN (SELECT id FROM payment_sessions WHERE kind = 'TRANSFER')"))
    bind.execute(sa.text("UPDATE payment_requests SET transaction_id = NULL"))
    bind.execute(sa.text("DELETE FROM transactions WHERE kind = 'TRANSFER'"))
    bind.execute(sa.text("DELETE FROM payment_sessions WHERE kind = 'TRANSFER'"))

    op.drop_index('uq_payment_sessions_idempotency', table_name='payment_sessions')
    op.drop_index('uq_payment_sessions_one_open_per_request', table_name='payment_sessions')
    op.drop_index('ix_payment_sessions_payer', table_name='payment_sessions')
    op.drop_constraint('ck_payment_sessions_shape', 'payment_sessions', type_='check')
    op.drop_constraint('fk_payment_sessions_request', 'payment_sessions', type_='foreignkey')
    op.drop_constraint('fk_payment_sessions_payee', 'payment_sessions', type_='foreignkey')
    op.drop_constraint('fk_payment_sessions_payer', 'payment_sessions', type_='foreignkey')
    op.alter_column('payment_sessions', 'merchant_id', nullable=False)
    for col in ('idempotency_key', 'payment_request_id', 'payee_user_id', 'payer_user_id', 'kind'):
        op.drop_column('payment_sessions', col)

    op.drop_index('ix_payment_requests_requester_created', table_name='payment_requests')
    op.drop_index('ix_payment_requests_payer_status', table_name='payment_requests')
    op.drop_index('ix_payment_requests_request_id', table_name='payment_requests')
    op.drop_table('payment_requests')

    op.drop_index('ix_transactions_recipient_ts', table_name='transactions')
    op.drop_constraint('ck_transactions_shape', 'transactions', type_='check')
    op.drop_constraint('fk_transactions_recipient', 'transactions', type_='foreignkey')
    op.alter_column('transactions', 'merchant_id', nullable=False)
    for col in ('note', 'currency', 'recipient_id', 'kind'):
        op.drop_column('transactions', col)

    op.drop_index('ix_facepay_id_history_user_id', table_name='facepay_id_history')
    op.drop_table('facepay_id_history')

    op.drop_constraint('ck_merchants_balance_non_negative', 'merchants', type_='check')
    op.drop_column('merchants', 'balance')
    op.drop_constraint('ck_users_balance_non_negative', 'users', type_='check')
    op.drop_constraint('ck_users_facepay_id_format', 'users', type_='check')
    op.drop_index('ix_users_facepay_id', table_name='users')
    for col in ('balance', 'facepay_id_changed_at', 'facepay_id'):
        op.drop_column('users', col)
