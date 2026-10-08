"""payment security: authorization binding, step-up PIN, biometric switch, audit references

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-09 01:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('biometric_payments_enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False))
    op.add_column('users', sa.Column('payment_pin_hash', sa.String(length=255), nullable=True))
    op.add_column('users', sa.Column('pin_changed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('pin_failed_attempts', sa.Integer(), server_default='0', nullable=False))
    op.add_column('users', sa.Column('pin_locked_until', sa.DateTime(timezone=True), nullable=True))

    # Existing (short-lived) authorizations predate the snapshot: the columns are nullable and a NULL snapshot is
    # treated as invalid at confirmation, so none of them can be used after this migration.
    op.add_column('payment_authorizations', sa.Column('merchant_id', sa.Integer(), nullable=True))
    op.add_column('payment_authorizations', sa.Column('amount', sa.Numeric(12, 2), nullable=True))
    op.add_column('payment_authorizations', sa.Column('currency', sa.String(length=3), nullable=True))
    op.add_column('payment_authorizations', sa.Column('order_reference', sa.String(length=80), nullable=True))
    op.add_column('payment_authorizations', sa.Column('model_version', sa.String(length=40), nullable=True))
    op.add_column('payment_authorizations', sa.Column('step_up_required', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.add_column('payment_authorizations', sa.Column('step_up_reasons', sa.String(length=160), nullable=True))
    op.add_column('payment_authorizations', sa.Column('step_up_verified_at', sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key('fk_payment_authorizations_merchant', 'payment_authorizations', 'merchants', ['merchant_id'], ['id'])

    op.add_column('authentication_logs', sa.Column('payment_session_ref', sa.String(length=40), nullable=True))
    op.add_column('authentication_logs', sa.Column('transaction_ref', sa.String(length=40), nullable=True))

    op.create_table(
        'security_events',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('kind', sa.String(length=40), nullable=False),
        sa.Column('session_ref', sa.String(length=40), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_security_events_user_ts', 'security_events', ['user_id', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_security_events_user_ts', table_name='security_events')
    op.drop_table('security_events')
    op.drop_column('authentication_logs', 'transaction_ref')
    op.drop_column('authentication_logs', 'payment_session_ref')
    op.drop_constraint('fk_payment_authorizations_merchant', 'payment_authorizations', type_='foreignkey')
    for col in ('step_up_verified_at', 'step_up_reasons', 'step_up_required', 'model_version', 'order_reference',
                'currency', 'amount', 'merchant_id'):
        op.drop_column('payment_authorizations', col)
    for col in ('pin_locked_until', 'pin_failed_attempts', 'pin_changed_at', 'payment_pin_hash', 'biometric_payments_enabled'):
        op.drop_column('users', col)
