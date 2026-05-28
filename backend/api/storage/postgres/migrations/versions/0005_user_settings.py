"""user_settings table (Sprint 1B)

Revision ID: 0005_user_settings
Revises: 0004_graph_notes
Create Date: 2026-05-28
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_user_settings"
down_revision: str | None = "0004_graph_notes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_settings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            unique=True,
            nullable=False,
        ),
        sa.Column(
            "validation_mode",
            sa.String,
            nullable=False,
            server_default="quick",
        ),
        sa.Column(
            "surface_on_by_default",
            sa.Boolean,
            nullable=False,
            server_default="true",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "validation_mode IN ('quick', 'strict', 'hybrid')",
            name="ck_user_settings_validation_mode",
        ),
    )


def downgrade() -> None:
    op.drop_table("user_settings")
