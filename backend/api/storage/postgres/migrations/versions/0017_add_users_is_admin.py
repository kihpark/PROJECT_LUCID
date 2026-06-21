"""add users.is_admin column for admin admission gate

Revision ID: 0017_add_users_is_admin
Revises: 0016_opl_v1_expansion
Create Date: 2026-06-21

B-61-fix-admission — promotion of an existing User to admin happens
manually after migration:
    UPDATE users SET is_admin = true WHERE email = '<PO email>';
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_add_users_is_admin"
down_revision: str | None = "0016_opl_v1_expansion"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Keep the server_default in place so raw INSERTs that don't
    # name is_admin still get is_admin=false. The ORM default also
    # sets is_admin=False on User() construction.


def downgrade() -> None:
    op.drop_column("users", "is_admin")
