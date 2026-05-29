"""extend source_jobs.status with structure-stage values (Sprint 3 PR-3-2)

Revision ID: 0011_source_status_structure
Revises: 0010_extracted_content
Create Date: 2026-05-29

Adds three structure-stage states to source_jobs.status CHECK
constraint:
  structuring        processor is running
  structured         done (decomposition + Object matching + Link creation)
  structure_failed   recoverable error during structure

The downgrade drops the new values; rows currently in any of those
states would violate the smaller constraint, so downgrade is for
greenfield envs only.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0011_source_status_structure"
down_revision: str | None = "0010_extracted_content"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_OLD = (
    "status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed')"
)
_NEW = (
    "status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed', "
    "'structuring', 'structured', 'structure_failed')"
)


def upgrade() -> None:
    op.drop_constraint("ck_source_job_status", "source_jobs", type_="check")
    op.create_check_constraint("ck_source_job_status", "source_jobs", _NEW)


def downgrade() -> None:
    op.drop_constraint("ck_source_job_status", "source_jobs", type_="check")
    op.create_check_constraint("ck_source_job_status", "source_jobs", _OLD)
