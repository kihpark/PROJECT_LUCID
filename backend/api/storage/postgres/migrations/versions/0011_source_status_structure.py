"""extend source_jobs.status with structure-stage values (Sprint 3 PR-3-2)

Revision ID: 0011_source_status_structure
Revises: 0010_extracted_content
Create Date: 2026-05-29

Adds three structure-stage states to source_jobs.status CHECK
constraint:
  structuring        processor is running
  structured         done (decomposition + Object matching + Link creation)
  structure_failed   recoverable error during structure

The downgrade normalises existing structure-stage rows to their
pre-3PR-3-2 vocabulary (structuring->extracting, structured->extracted,
structure_failed->extract_failed) BEFORE tightening the CHECK, so the
downgrade is now data-safe on populated DBs.
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
    # Production-safe: normalise structure-stage rows back to the
    # pre-3PR-3-2 vocabulary BEFORE tightening the CHECK. ALTER TABLE
    # ADD CHECK validates existing rows; without this update the
    # downgrade would fail with CheckViolation on any container that
    # has captured + structured anything.
    #
    # Mapping (preserves in-progress / done / failed semantics):
    #   structuring        -> extracting
    #   structured         -> extracted
    #   structure_failed   -> extract_failed
    op.execute(
        "UPDATE source_jobs SET status = "
        "CASE status "
        "  WHEN 'structuring'       THEN 'extracting' "
        "  WHEN 'structured'        THEN 'extracted' "
        "  WHEN 'structure_failed'  THEN 'extract_failed' "
        "  ELSE status "
        "END "
        "WHERE status IN ('structuring','structured','structure_failed')"
    )
    op.drop_constraint("ck_source_job_status", "source_jobs", type_="check")
    op.create_check_constraint("ck_source_job_status", "source_jobs", _OLD)
