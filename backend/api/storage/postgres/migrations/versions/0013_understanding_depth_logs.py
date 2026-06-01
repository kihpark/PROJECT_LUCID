"""understanding_depth_logs (Track A DCR-002 v2 / DR-066)

Revision ID: 0013_understanding_depth_logs
Revises: 0012_structure_metrics_logs
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0013_understanding_depth_logs"
down_revision: str | None = "0012_structure_metrics_logs"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.create_table(
        "understanding_depth_logs",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "knowledge_space_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("average_depth", sa.Float(), nullable=False),
        sa.Column("max_depth", sa.Integer(), nullable=False),
        sa.Column("isolated_facts_count", sa.Integer(), nullable=False),
        sa.Column("total_facts", sa.Integer(), nullable=False),
        sa.Column(
            "measured_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "average_depth >= 0 AND max_depth >= 0 "
            "AND isolated_facts_count >= 0 AND total_facts >= 0",
            name="ck_understanding_depth_nonneg",
        ),
    )
    op.create_index(
        "ix_understanding_depth_logs_knowledge_space_id",
        "understanding_depth_logs",
        ["knowledge_space_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_understanding_depth_logs_knowledge_space_id",
        table_name="understanding_depth_logs",
    )
    op.drop_table("understanding_depth_logs")
