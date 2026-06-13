"""Unit tests for api.extractors.processor — idempotency invariants.

B-26: companion to the integration test
`test_extract_idempotent_on_already_extracted`. These tests pin down
the extract-stage idempotency contract that the integration test was
trying (badly) to cover. They are deterministic — no DB, no threads,
no race window.

The contract (DR-089 dogfood, PR-3-3):

  process_source_job(job_id) is a no-op whenever the job's status is
  anything OTHER than PENDING_EXTRACT or EXTRACTING. The state guard
  at processor.py:90-99 enforces this.

  No-op means specifically:
    1. dispatch_extract (the Claude/extractor call) is NOT invoked
    2. _enqueue_structure_async (the structure-stage trigger) is NOT
       invoked
    3. The SourceJob row is NOT mutated (status, extracted_at,
       error_message all unchanged)

Reason no-op matters: a duplicate dispatch_extract would burn a
second Claude API call (cost). A duplicate _enqueue_structure_async
would fire a second structure thread, which would attempt to
re-extract facts from the same source and could produce duplicate
FactNodes / FactObjectLinks in Postgres + Elasticsearch (data
integrity).
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from api.extractors import processor as proc_mod
from api.models.source_job import SourceStatus

# Every post-pending status the production code may ever observe on a
# re-call. 'extracted' is the most common — the daemon thread races
# with the BackgroundTask completion. Later states (structuring,
# structured) can also be observed when the structure stage has
# already advanced. Failure states are likewise terminal.
POST_PENDING_STATUSES = [
    SourceStatus.EXTRACTED.value,
    SourceStatus.EXTRACT_FAILED.value,
    SourceStatus.STRUCTURING.value,
    SourceStatus.STRUCTURED.value,
    SourceStatus.STRUCTURE_FAILED.value,
]


def _make_extracted_job(status: str) -> MagicMock:
    """Build a mock SourceJob row already past pending_extract.

    The mock exposes the attributes the processor reads: status,
    raw_payload, source_type, source_url, captured_from, captured_at,
    knowledge_space_id, client_metadata, plus the success/failure
    artefacts the state-guard early-return path must leave untouched.
    """
    job = MagicMock()
    job.id = uuid.uuid4()
    job.status = status
    job.raw_payload = b""
    job.source_type = "web_article"
    job.source_url = "https://example.com/idem-unit"
    job.captured_from = "chrome_ext"
    job.captured_at = datetime.now(UTC)
    job.knowledge_space_id = uuid.uuid4()
    job.client_metadata = {}
    job.extracted_text = "previously-extracted text"
    job.extracted_metadata = {"title": "frozen"}
    job.extraction_warnings = []
    job.extracted_at = datetime(2026, 6, 1, tzinfo=UTC)
    job.error_message = None
    job.updated_at = datetime(2026, 6, 1, tzinfo=UTC)
    return job


def _wire_session(monkeypatch, job: MagicMock) -> MagicMock:
    """Patch processor.make_sessionmaker so the production code reads
    `job` back. Returns the session mock so callers can assert against
    commit()/close()."""
    session = MagicMock()
    session.get = MagicMock(return_value=job)
    session.commit = MagicMock()
    session.close = MagicMock()
    sm_factory = MagicMock(return_value=session)
    monkeypatch.setattr(proc_mod, "make_sessionmaker", lambda: sm_factory)
    return session


@pytest.mark.parametrize("status", POST_PENDING_STATUSES)
def test_process_source_job_no_op_when_already_past_pending(monkeypatch, status):
    """State guard must early-return without invoking dispatch_extract
    or _enqueue_structure_async, and without mutating the row."""
    job = _make_extracted_job(status)
    session = _wire_session(monkeypatch, job)

    dispatch_counter = MagicMock()
    monkeypatch.setattr(proc_mod, "dispatch_extract", dispatch_counter)
    structure_counter = MagicMock()
    monkeypatch.setattr(proc_mod, "_enqueue_structure_async", structure_counter)

    snapshot = {
        "status": job.status,
        "extracted_at": job.extracted_at,
        "extracted_text": job.extracted_text,
        "extracted_metadata": dict(job.extracted_metadata),
        "error_message": job.error_message,
        "updated_at": job.updated_at,
    }

    proc_mod.process_source_job(job.id)

    # No re-extract: this is the key cost/idempotency invariant.
    # A duplicate call here would mean a second Claude API charge AND
    # a second structure-stage dispatch leading to duplicate facts.
    assert dispatch_counter.call_count == 0, (
        f"dispatch_extract was called on a {status!r} job — "
        f"state guard regression. Each call costs a Claude API spend."
    )
    assert structure_counter.call_count == 0, (
        f"_enqueue_structure_async was called on a {status!r} job — "
        f"would fire a second structure thread and create duplicate "
        f"facts in Postgres + Elasticsearch."
    )

    # Row untouched: the guard returns BEFORE the lock-by-status
    # `pending_extract -> extracting` transition. No commit() must
    # have happened from the guard path.
    assert job.status == snapshot["status"]
    assert job.extracted_at == snapshot["extracted_at"]
    assert job.extracted_text == snapshot["extracted_text"]
    assert job.extracted_metadata == snapshot["extracted_metadata"]
    assert job.error_message == snapshot["error_message"]
    assert job.updated_at == snapshot["updated_at"]
    assert session.commit.call_count == 0
    # Session opened + closed in the finally block.
    assert session.close.call_count == 1


def test_process_source_job_runs_when_pending_extract(monkeypatch):
    """Positive case: from PENDING_EXTRACT the processor MUST run.

    Verifies the state guard's permit-list (pending_extract,
    extracting) actually lets work through. Without this companion
    case, the guard could be silently bricked (`if True: return`)
    and the no-op tests would all pass.
    """
    from api.extractors.base import ExtractResult

    job = _make_extracted_job(SourceStatus.PENDING_EXTRACT.value)
    # Reset extract artefacts since the row hasn't been processed yet.
    job.extracted_text = None
    job.extracted_at = None
    _wire_session(monkeypatch, job)

    fake_result = ExtractResult(
        merged_text="new extracted body",
        extracted_metadata={"title": "new"},
        extraction_warnings=[],
    )
    dispatch_counter = MagicMock(return_value=fake_result)
    monkeypatch.setattr(proc_mod, "dispatch_extract", dispatch_counter)
    structure_counter = MagicMock()
    monkeypatch.setattr(proc_mod, "_enqueue_structure_async", structure_counter)

    proc_mod.process_source_job(job.id)

    assert dispatch_counter.call_count == 1
    # Structure dispatched exactly once on success.
    assert structure_counter.call_count == 1
    assert job.status == SourceStatus.EXTRACTED.value
    assert job.extracted_text == "new extracted body"
