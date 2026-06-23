"""extend source_jobs.status with 'validated' terminal state (decide-status-transition)

Revision ID: 0018_source_status_validated
Revises: 0017_add_users_is_admin
Create Date: 2026-06-23

Adds the 'validated' terminal state to source_jobs.status CHECK
constraint.

Motivation (PO live evidence):
  All 10 source_jobs were stuck at status='structured' even though
  the PO had completed validation on multiple jobs. The Decide
  handler wrote facts to ES and recorded validation_logs entries but
  never flipped source_jobs.status, so the "검증 대기" home count
  never dropped. We introduce a terminal state 'validated' that the
  decide handler flips to after a successful Submit; the home
  pending count filters by status='structured' so validated jobs
  drop out naturally.

The downgrade normalises any existing 'validated' rows back to
'structured' BEFORE tightening the CHECK so it is safe to run on a
populated DB.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0018_source_status_validated"
down_revision: str | None = "0017_add_users_is_admin"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_OLD = (
    "status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed', "
    "'structuring', 'structured', 'structure_failed')"
)
_NEW = (
    "status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed', "
    "'structuring', 'structured', 'structure_failed', 'validated')"
)


def upgrade() -> None:
    op.drop_constraint("ck_source_job_status", "source_jobs", type_="check")
    op.create_check_constraint("ck_source_job_status", "source_jobs", _NEW)


def downgrade() -> None:
    # Production-safe: collapse 'validated' rows back to 'structured'
    # BEFORE re-installing the tighter CHECK; otherwise ALTER TABLE
    # ADD CHECK would fail with CheckViolation on any DB that has
    # already started flipping rows.
    op.execute(
        "UPDATE source_jobs SET status = 'structured' WHERE status = 'validated'"
    )
    op.drop_constraint("ck_source_job_status", "source_jobs", type_="check")
    op.create_check_constraint("ck_source_job_status", "source_jobs", _OLD)
