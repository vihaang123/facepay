"""face samples, model artifacts, one-active constraints

Revision ID: 0003
Revises: 0002
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'face_samples',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('pose', sa.String(length=20), nullable=False),
        sa.Column('crop_encrypted', sa.LargeBinary(), nullable=False),
        sa.Column('sharpness', sa.Float(), nullable=False),
        sa.Column('brightness', sa.Float(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_face_samples_user_id_users', ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_face_samples_user_pose', 'face_samples', ['user_id', 'pose'])

    op.add_column('model_versions', sa.Column('artifact', sa.LargeBinary(), nullable=True))
    op.add_column('model_versions', sa.Column('n_samples', sa.Integer(), nullable=True))
    op.add_column('model_versions', sa.Column('n_classes', sa.Integer(), nullable=True))
    op.add_column('model_versions', sa.Column('dataset_fingerprint', sa.String(length=64), nullable=True))
    op.add_column('model_versions', sa.Column('library_versions', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.create_index('uq_model_versions_one_active', 'model_versions', ['status'], unique=True,
                    postgresql_where=sa.text("status = 'active'"))
    op.create_index('uq_face_profiles_one_active', 'face_profiles', ['user_id'], unique=True,
                    postgresql_where=sa.text("status = 'active'"))


def downgrade() -> None:
    op.drop_index('uq_face_profiles_one_active', table_name='face_profiles')
    op.drop_index('uq_model_versions_one_active', table_name='model_versions')
    for col in ('library_versions', 'dataset_fingerprint', 'n_classes', 'n_samples', 'artifact'):
        op.drop_column('model_versions', col)
    op.drop_index('ix_face_samples_user_pose', table_name='face_samples')
    op.drop_table('face_samples')
