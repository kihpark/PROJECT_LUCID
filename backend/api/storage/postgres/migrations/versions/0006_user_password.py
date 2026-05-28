"""add password_hash to users (Sprint 1B)

Revision ID: 0006_user_password
Revises: 0005_user_settings
Create Date: 2026-05-28

Adds a nullable `password_hash` column to `users`. Nullable so existing
rows (seeded before this migration) survive; the auth route requires
the column to be set when users register through the new flow.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_user_password"
down_revision: str | None = "0005_user_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("password_hash", sa.String, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "password_hash")
