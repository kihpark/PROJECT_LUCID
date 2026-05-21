"""archetype surveys (5-dimension wedge discovery)

Revision ID: 0003_archetype_surveys
Revises: 0002_source_policies
Create Date: 2026-05-21
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_archetype_surveys"
down_revision: str | None = "0002_source_policies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "archetype_surveys",
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
        sa.Column("consumption_intensity", sa.String, nullable=True),
        sa.Column("validation_frequency", sa.String, nullable=True),
        sa.Column("surface_usage", sa.String, nullable=True),
        sa.Column("domain_diversity", sa.String, nullable=True),
        sa.Column("device_environment", sa.String, nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("skipped", sa.Boolean, server_default="false", nullable=False),
    )


def downgrade() -> None:
    op.drop_table("archetype_surveys")
