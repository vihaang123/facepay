"""Mobile-number accounts: number registry, demo one-time codes, sign-in lock

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-06 16:00:00

users.email and merchants.email become optional (an account made with a mobile number has none); both tables gain the number
and the app passcode hash. mobile_numbers is the registry that makes one number belong to exactly one account. otp_challenges
holds DEMO codes (hashed). signin_attempts counts wrong passcodes per number for the lock.
Nothing is deleted on upgrade. Downgrade refuses to run while any account has no email, because making the column required
again would otherwise mean deleting those people's accounts.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0012'
down_revision: Union[str, Sequence[str], None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("users", "merchants"):
        op.alter_column(table, "email", existing_type=sa.String(255), nullable=True)
        op.add_column(table, sa.Column("mobile", sa.String(10), nullable=True))
        op.add_column(table, sa.Column("passcode_hash", sa.String(255), nullable=True))
    op.create_table(
        "mobile_numbers",
        sa.Column("mobile", sa.String(10), primary_key=True),
        sa.Column("account_type", sa.String(10), nullable=False),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("merchant_id", sa.Integer, sa.ForeignKey("merchants.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("account_type IN ('user', 'merchant')", name="ck_mobile_numbers_type"),
        sa.CheckConstraint(
            "(account_type = 'user' AND user_id IS NOT NULL AND merchant_id IS NULL)"
            " OR (account_type = 'merchant' AND merchant_id IS NOT NULL AND user_id IS NULL)",
            name="ck_mobile_numbers_one_owner",
        ),
        sa.CheckConstraint("mobile ~ '^[6-9][0-9]{9}$'", name="ck_mobile_numbers_format"),
    )
    op.create_index("uq_mobile_numbers_user", "mobile_numbers", ["user_id"], unique=True, postgresql_where=sa.text("user_id IS NOT NULL"))
    op.create_index("uq_mobile_numbers_merchant", "mobile_numbers", ["merchant_id"], unique=True, postgresql_where=sa.text("merchant_id IS NOT NULL"))
    op.create_table(
        "otp_challenges",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("challenge_id", sa.String(40), nullable=False),
        sa.Column("mobile", sa.String(10), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("attempts", sa.Integer, server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_otp_challenges_challenge_id", "otp_challenges", ["challenge_id"], unique=True)
    op.create_index("ix_otp_challenges_mobile", "otp_challenges", ["mobile", "created_at"])
    op.create_table(
        "signin_attempts",
        sa.Column("mobile", sa.String(10), primary_key=True),
        sa.Column("failed_count", sa.Integer, server_default="0", nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    conn = op.get_bind()
    for table in ("users", "merchants"):
        n = conn.execute(sa.text(f"SELECT count(*) FROM {table} WHERE email IS NULL")).scalar()
        if n:
            raise RuntimeError(
                f"Cannot downgrade: {n} row(s) in {table} were made with a mobile number and have no email. "
                "Removing them would delete those accounts; give them an email or remove them yourself first."
            )
    op.drop_table("signin_attempts")
    op.drop_index("ix_otp_challenges_mobile", table_name="otp_challenges")
    op.drop_index("ix_otp_challenges_challenge_id", table_name="otp_challenges")
    op.drop_table("otp_challenges")
    op.drop_index("uq_mobile_numbers_merchant", table_name="mobile_numbers")
    op.drop_index("uq_mobile_numbers_user", table_name="mobile_numbers")
    op.drop_table("mobile_numbers")
    for table in ("users", "merchants"):
        op.drop_column(table, "passcode_hash")
        op.drop_column(table, "mobile")
        op.alter_column(table, "email", existing_type=sa.String(255), nullable=False)
