"""payment authorizations and session lifecycle

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-07 17:10:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Session lifecycle: add AUTHENTICATED and FAILED.
    op.drop_constraint('ck_payment_sessions_status', 'payment_sessions', type_='check')
    op.create_check_constraint(
        'ck_payment_sessions_status', 'payment_sessions',
        "status IN ('CREATED', 'AUTHENTICATED', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')",
    )
    op.add_column('payment_sessions', sa.Column('failed_auth_attempts', sa.Integer(), server_default='0', nullable=False))

    op.create_table(
        'payment_authorizations',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('payment_session_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('authentication_log_id', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=20), server_default='ACTIVE', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED')", name='ck_payment_authorizations_status'),
        sa.ForeignKeyConstraint(['authentication_log_id'], ['authentication_logs.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['payment_session_id'], ['payment_sessions.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_payment_authorizations_session', 'payment_authorizations', ['payment_session_id'], unique=False)
    op.create_index(
        'uq_payment_authorizations_one_active', 'payment_authorizations', ['payment_session_id', 'user_id'],
        unique=True, postgresql_where=sa.text("status = 'ACTIVE'"),
    )
    op.create_index(
        'uq_transactions_one_success_per_session', 'transactions', ['payment_session_id'],
        unique=True, postgresql_where=sa.text("status = 'SUCCESS' AND payment_session_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index('uq_transactions_one_success_per_session', table_name='transactions',
                  postgresql_where=sa.text("status = 'SUCCESS' AND payment_session_id IS NOT NULL"))
    op.drop_index('uq_payment_authorizations_one_active', table_name='payment_authorizations',
                  postgresql_where=sa.text("status = 'ACTIVE'"))
    op.drop_index('ix_payment_authorizations_session', table_name='payment_authorizations')
    op.drop_table('payment_authorizations')
    op.drop_column('payment_sessions', 'failed_auth_attempts')
    # Rows in the two new states cannot satisfy the old constraint: map them back first.
    op.execute("UPDATE payment_sessions SET status = 'CREATED' WHERE status = 'AUTHENTICATED'")
    op.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status = 'FAILED'")
    op.drop_constraint('ck_payment_sessions_status', 'payment_sessions', type_='check')
    op.create_check_constraint(
        'ck_payment_sessions_status', 'payment_sessions',
        "status IN ('CREATED', 'PAID', 'EXPIRED', 'CANCELLED')",
    )
