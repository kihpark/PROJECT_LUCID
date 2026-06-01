"""structure_metrics_logs (Sprint 3 PR-3-3)

Revision ID: 0012
Revises: 0011
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "structure_metrics_logs",
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
            "source_job_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("source_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("fact_count", sa.Integer(), nullable=False),
        sa.Column("object_count_auto", sa.Integer(), nullable=False),
        sa.Column("object_count_new", sa.Integer(), nullable=False),
        sa.Column("object_count_disambig", sa.Integer(), nullable=False),
        sa.Column("link_count", sa.Integer(), nullable=False),
        sa.Column("negates_count", sa.Integer(), nullable=False),
        sa.Column("decomposer_model", sa.String(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "logged_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "fact_count >= 0 AND object_count_auto >= 0 "
            "AND object_count_new >= 0 AND object_count_disambig >= 0 "
            "AND link_count >= 0 AND negates_count >= 0",
            name="ck_structure_metrics_nonneg",
        ),
    )
    op.create_index(
        "ix_structure_metrics_logs_source_job_id",
        "structure_metrics_logs",
        ["source_job_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_structure_metrics_logs_source_job_id",
        table_name="structure_metrics_logs",
    )
    op.drop_table("structure_metrics_logs")
