"""Unit: SourceStatus enum — 'validated' parity with alembic 0018 / ORM.

fix/sourcestatus-validated-enum

The 'validated' value lives in three places:
  - Pydantic StrEnum (api/models/source_job.py)         <-- this fix added it
  - SQLAlchemy ORM CHECK constraint (storage/postgres/orm.py)
  - alembic migration 0018_source_status_validated.py

When the Pydantic enum is missing 'validated' and the DB has flipped a
row to that state, GET /api/jobs/{job_id} 500s at JobStatusResponse
coercion. These tests pin the parity so a future regression is loud.
"""
from __future__ import annotations

import pytest

from api.models.base import new_uid
from api.models.source_job import JobStatusResponse, SourceStatus


def test_source_status_includes_validated() -> None:
    """'validated' is the terminal state added in alembic 0018."""
    assert SourceStatus("validated") is SourceStatus.VALIDATED
    assert SourceStatus.VALIDATED.value == "validated"


def test_source_status_full_set_post_0018() -> None:
    """All eight lifecycle states are reachable via the StrEnum."""
    assert set(SourceStatus) == {
        SourceStatus.PENDING_EXTRACT,
        SourceStatus.EXTRACTING,
        SourceStatus.EXTRACTED,
        SourceStatus.EXTRACT_FAILED,
        SourceStatus.STRUCTURING,
        SourceStatus.STRUCTURED,
        SourceStatus.STRUCTURE_FAILED,
        SourceStatus.VALIDATED,
    }


def test_job_status_response_accepts_validated_string() -> None:
    """Round-trip: server JSON with status='validated' parses without 500.

    This is the regression that used to crash GET /api/jobs/{validated_id}
    — Pydantic raised ValidationError (which FastAPI rendered as 500) at
    JobStatusResponse coercion because 'validated' was not in the enum.
    """
    payload = {
        "job_id": new_uid(),
        "knowledge_space_id": new_uid(),
        "source_url": "https://example.com/article",
        "source_type": "web_article",
        "status": "validated",
        "captured_at": "2026-06-24T08:00:00Z",
        "captured_from": "chrome_ext",
        "error_message": None,
        "created_at": "2026-06-24T08:00:00Z",
        "updated_at": "2026-06-24T08:00:00Z",
    }
    parsed = JobStatusResponse.model_validate(payload)
    assert parsed.status is SourceStatus.VALIDATED
    # Round-trip through JSON to mirror what the route returns to the
    # client (FastAPI uses model_dump_json under the hood).
    dumped = parsed.model_dump(mode="json")
    assert dumped["status"] == "validated"


def test_job_status_response_rejects_unknown_status() -> None:
    """Sanity: an off-list status still raises (we did NOT loosen the enum)."""
    payload = {
        "job_id": new_uid(),
        "knowledge_space_id": new_uid(),
        "source_url": "https://example.com/article",
        "source_type": "web_article",
        "status": "definitely_not_a_real_state",
        "captured_at": "2026-06-24T08:00:00Z",
        "captured_from": "chrome_ext",
        "error_message": None,
        "created_at": "2026-06-24T08:00:00Z",
        "updated_at": "2026-06-24T08:00:00Z",
    }
    with pytest.raises(Exception):  # pydantic.ValidationError subclass
        JobStatusResponse.model_validate(payload)


def test_source_status_check_constraint_parity() -> None:
    """The ORM CHECK constraint and the StrEnum must list the same values.

    If someone widens one without the other, the next round of the
    extract→structure→decide loop will produce a 500 in the field. This
    test reads both lists at import time so the parity check is cheap.
    """
    from api.storage.postgres.orm import SourceJobORM

    enum_values = {s.value for s in SourceStatus}
    # Pull the CHECK constraint sqltext for the status column.
    check_args = [
        c for c in SourceJobORM.__table_args__
        if getattr(c, "name", None) == "ck_source_job_status"
    ]
    assert len(check_args) == 1, "ck_source_job_status missing on ORM"
    sqltext = str(check_args[0].sqltext)
    for value in enum_values:
        assert f"'{value}'" in sqltext, (
            f"SourceStatus.{value} is in the Python enum but not in the ORM "
            f"CHECK constraint — alembic + ORM must be widened together."
        )
