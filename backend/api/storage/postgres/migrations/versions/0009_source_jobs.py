"""source_jobs table (Sprint 2C PR-2C-1)

Revision ID: 0009_source_jobs
Revises: 0008_metrics_logs
Create Date: 2026-05-28

Stores capture-time jobs from /api/capture. raw_payload is gzip-
compressed before insertion (helper in api.storage.postgres.compression).
status CHECK is intentionally narrow — only Sprint 2C values land here;
Sprint 3 extends with a separate migration when 'pending_structure'
and downstream states are introduced.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009_source_jobs"
down_revision: str | None = "0008_metrics_logs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "source_jobs",
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
            nullable=False,
            index=True,
        ),
        sa.Column(
            "knowledge_space_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("knowledge_spaces.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("source_url", sa.String(2048), nullable=False),
        sa.Column("source_type", sa.String, nullable=False),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("captured_from", sa.String, nullable=False),
        sa.Column("raw_payload", sa.LargeBinary, nullable=True),
        sa.Column(
            "status",
            sa.String,
            server_default="pending_extract",
            nullable=False,
            index=True,
        ),
        sa.Column(
            "policy_at_capture",
            sa.String,
            server_default="careful",
            nullable=False,
        ),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("client_metadata", postgresql.JSONB, nullable=True),
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
            "status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed')",
            name="ck_source_job_status",
        ),
        sa.CheckConstraint(
            "captured_from IN ('chrome_ext', 'pwa_share', 'api')",
            name="ck_source_job_captured_from",
        ),
        sa.CheckConstraint(
            "policy_at_capture IN ('trusted', 'careful')",
            name="ck_source_job_policy",
        ),
    )


def downgrade() -> None:
    op.drop_table("source_jobs")
