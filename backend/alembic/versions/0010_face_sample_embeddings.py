"""Store a deep face embedding next to each enrolment sample

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-03 01:30:00

face_samples.embedding_encrypted holds the encrypted 128-number embedding of the sample (only written when FACE_ENGINE=embedding).
Nullable and unused by the default engine, so nothing changes for existing data. Nothing is deleted.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0010'
down_revision: Union[str, Sequence[str], None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("face_samples", sa.Column("embedding_encrypted", sa.LargeBinary(), nullable=True))


def downgrade() -> None:
    op.drop_column("face_samples", "embedding_encrypted")
