"""face authentication: challenges and richer authentication logs

Revision ID: 0004
Revises: 0003
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'face_auth_challenges',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('token', sa.String(length=64), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('challenge', sa.String(length=20), nullable=False),
        sa.Column('issued_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_face_auth_challenges_user_id_users', ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token', name='uq_face_auth_challenges_token'),
    )
    op.create_index('ix_face_auth_challenges_user', 'face_auth_challenges', ['user_id'])
    op.add_column('authentication_logs', sa.Column('failure_reason', sa.String(length=40), nullable=True))
    op.add_column('authentication_logs', sa.Column('failure_detail', sa.String(length=40), nullable=True))
    op.add_column('authentication_logs', sa.Column('distance', sa.Double(), nullable=True))
    op.add_column('authentication_logs', sa.Column('challenge', sa.String(length=20), nullable=True))
    op.add_column('authentication_logs', sa.Column('model_version', sa.String(length=40), nullable=True))


def downgrade() -> None:
    for col in ('model_version', 'challenge', 'distance', 'failure_detail', 'failure_reason'):
        op.drop_column('authentication_logs', col)
    op.drop_index('ix_face_auth_challenges_user', table_name='face_auth_challenges')
    op.drop_table('face_auth_challenges')
