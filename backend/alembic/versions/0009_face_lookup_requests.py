"""Find a customer by face, mandatory purpose and reference on requests

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-02 00:30:00

What changes and why:
* users.face_lookup_enabled: a customer must switch on "Let shops and friends find me by face" before anyone can find them
  with a camera. Off for everyone until they choose (existing customers included).
* face_lookups: a short-lived, single-use ticket that says "this requester found this customer by face". It lets the
  requester send a request without ever being told the customer's FacePay ID. Only a hash of the ticket is stored.
* payment_requests.purpose / source and payment_sessions.purpose: why the money is being asked for (a fixed category;
  the free-text reference is the existing note / order_reference column) and how the customer was found (ID or FACE).

Backward compatible: every new column is nullable or has a server default and nothing is deleted.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("face_lookup_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("payment_requests", sa.Column("purpose", sa.String(24), nullable=True))
    op.add_column("payment_requests", sa.Column("source", sa.String(16), nullable=True))
    op.add_column("payment_sessions", sa.Column("purpose", sa.String(24), nullable=True))
    op.create_table(
        "face_lookups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("requester_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("requester_merchant_id", sa.Integer(), sa.ForeignKey("merchants.id", ondelete="CASCADE"), nullable=True),
        sa.Column("target_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(requester_user_id IS NOT NULL AND requester_merchant_id IS NULL)"
            " OR (requester_user_id IS NULL AND requester_merchant_id IS NOT NULL)",
            name="ck_face_lookups_one_requester",
        ),
    )
    op.create_index("ix_face_lookups_token_hash", "face_lookups", ["token_hash"], unique=True)
    op.create_index("ix_face_lookups_target", "face_lookups", ["target_user_id"])


def downgrade() -> None:
    op.drop_index("ix_face_lookups_target", table_name="face_lookups")
    op.drop_index("ix_face_lookups_token_hash", table_name="face_lookups")
    op.drop_table("face_lookups")
    op.drop_column("payment_sessions", "purpose")
    op.drop_column("payment_requests", "source")
    op.drop_column("payment_requests", "purpose")
    op.drop_column("users", "face_lookup_enabled")
