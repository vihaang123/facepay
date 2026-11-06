"""Bank account discovery: holder name, IFSC, branch and source stored with a bank link

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-06 17:00:00

The discovery provider's answer is stored on bank_connections so it reads the same after logout, login and restart. Existing demo
links get the holder name the simulated record would show (the customer's registered name, in capitals). Their IFSC and branch
stay empty: nothing is invented for them. Downgrade drops the four columns.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0013'
down_revision: Union[str, Sequence[str], None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("bank_connections", sa.Column("holder_name", sa.String(120), nullable=True))
    op.add_column("bank_connections", sa.Column("ifsc", sa.String(11), nullable=True))
    op.add_column("bank_connections", sa.Column("branch", sa.String(120), nullable=True))
    op.add_column("bank_connections", sa.Column("discovery_source", sa.String(24), nullable=True))
    op.create_check_constraint("ck_bank_connections_ifsc", "bank_connections", "ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'")
    op.execute(
        "UPDATE bank_connections b SET holder_name = upper(regexp_replace(trim(u.name), '\\s+', ' ', 'g')), discovery_source = 'SIMULATED' "
        "FROM users u WHERE u.id = b.user_id"
    )


def downgrade() -> None:
    op.drop_constraint("ck_bank_connections_ifsc", "bank_connections", type_="check")
    for col in ("discovery_source", "branch", "ifsc", "holder_name"):
        op.drop_column("bank_connections", col)
