"""Unit tests for `_record_success` title persistence (pending-card-title-date).

The extractor used to surface `title` on ExtractResult but the
processor wrote only `result.extracted_metadata` onto the row,
dropping the title on the floor. The Pending Queue API then had
nothing better than the URL hostname to render — which is exactly
what the PO had been complaining about. These tests pin the new
fold-title-into-metadata invariant so a future refactor cannot
silently re-introduce the regression.
"""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

from api.extractors.base import ExtractResult
from api.extractors.processor import _record_success


def _fake_job() -> MagicMock:
    job = MagicMock()
    job.extracted_metadata = {}
    job.extracted_text = None
    job.extraction_warnings = []
    job.error_message = "stale"
    return job


def test_record_success_persists_title_into_metadata() -> None:
    job = _fake_job()
    session = MagicMock()
    result = ExtractResult(
        merged_text="body",
        title="중국 정부, 미국 기업 10곳에 수출통제",
        author="기자 김아무개",
        publish_date=datetime(2026, 6, 23, 12, 0, tzinfo=UTC),
        language="ko",
        extracted_metadata={"extractor_strategy": "trafilatura"},
    )
    _record_success(session, job, result)
    md = job.extracted_metadata
    assert md["title"] == "중국 정부, 미국 기업 10곳에 수출통제"
    assert md["author"] == "기자 김아무개"
    # publish_date stored as ISO string so JSONB is happy across drivers.
    assert isinstance(md["publish_date"], str)
    assert md["publish_date"].startswith("2026-06-23")
    # Pre-existing extractor metadata survives the fold.
    assert md["extractor_strategy"] == "trafilatura"
    session.commit.assert_called_once()


def test_record_success_does_not_override_existing_title_in_metadata() -> None:
    """If the extractor already wrote `title` into extracted_metadata
    directly (defensive — no current extractor does this), the value
    set by the extractor wins; the top-level field is only a fallback."""
    job = _fake_job()
    session = MagicMock()
    result = ExtractResult(
        merged_text="body",
        title="top-level title",
        extracted_metadata={"title": "metadata title"},
    )
    _record_success(session, job, result)
    assert job.extracted_metadata["title"] == "metadata title"


def test_record_success_handles_missing_title_gracefully() -> None:
    """Title is optional on ExtractResult — _record_success must not
    crash and must leave `title` absent so the read path's fallback
    chain takes over."""
    job = _fake_job()
    session = MagicMock()
    result = ExtractResult(merged_text="body")
    _record_success(session, job, result)
    assert "title" not in job.extracted_metadata
    assert "author" not in job.extracted_metadata
    assert "publish_date" not in job.extracted_metadata
