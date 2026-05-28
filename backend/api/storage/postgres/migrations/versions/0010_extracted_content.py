"""extracted content columns on source_jobs (Sprint 2C PR-2C-3)

Revision ID: 0010_extracted_content
Revises: 0009_source_jobs
Create Date: 2026-05-28

Adds 4 columns to source_jobs in place of a separate extracted_contents
table (architect option A, PR-2C-3): 1:1 with the SourceJob row so no
JOIN cost.

- extracted_text         TEXT       NULL       merged_text from the extractor
- extracted_metadata     JSONB      DEFAULT {} extractor-specific metadata
- extraction_warnings    JSONB      DEFAULT [] non-fatal issues to surface in Decide
- extracted_at           TIMESTAMPTZ NULL       timestamp set when status='extracted'

PostgreSQL TOAST automatically compresses the TEXT column on disk;
the ORM marks extracted_text as deferred() so list queries don't fetch
the body bytes.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010_extracted_content"
down_revision: str | None = "0009_source_jobs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "source_jobs",
        sa.Column("extracted_text", sa.Text, nullable=True),
    )
    op.add_column(
        "source_jobs",
        sa.Column(
            "extracted_metadata",
            postgresql.JSONB,
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "source_jobs",
        sa.Column(
            "extraction_warnings",
            postgresql.JSONB,
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "source_jobs",
        sa.Column("extracted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("source_jobs", "extracted_at")
    op.drop_column("source_jobs", "extraction_warnings")
    op.drop_column("source_jobs", "extracted_metadata")
    op.drop_column("source_jobs", "extracted_text")
