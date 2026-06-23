"""Unit: selection-save bypass threshold + helper behaviors.

Covers the `_try_selection_bypass` and `_detect_language_bypass`
helpers and the threshold boundary in
`backend/api/extractors/processor.py`. These are deliberately pure
function tests — no DB, no extractor chain, no Claude.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from api.extractors import processor


def _make_job() -> MagicMock:
    """Minimal job ORM stub with the columns _record_success touches."""
    job = MagicMock()
    job.id = "00000000-0000-0000-0000-000000000001"
    job.source_url = "https://www.newsis.com/view/NIS-1"
    job.status = "extracting"
    job.client_metadata = {}
    job.extraction_warnings = []
    return job


def _meta(selection: str, page_title: str = "PO 기사", url: str | None = None) -> dict:
    meta: dict[str, object] = {
        "source_url": url or "https://www.newsis.com/view/NIS-1",
        "selection_text": selection,
    }
    if page_title:
        meta["page_title"] = page_title
    return meta


# ---------------------------------------------------------------------------
# Threshold boundary cases
# ---------------------------------------------------------------------------
def test_selection_bypass_skips_below_threshold():
    """49-char selection falls through — bypass returns False, no commit."""
    session = MagicMock()
    job = _make_job()
    fired = processor._try_selection_bypass(session, job, _meta("x" * 49))
    assert fired is False
    session.commit.assert_not_called()


def test_selection_bypass_fires_at_exactly_threshold():
    """50-char selection is the boundary — bypass fires."""
    session = MagicMock()
    job = _make_job()
    text = "x" * 50
    fired = processor._try_selection_bypass(session, job, _meta(text))
    assert fired is True
    assert job.extracted_text == text
    assert job.extracted_metadata["extractor"] == "selection-bypass"
    assert job.extracted_metadata["capture_mode"] == "selection"


def test_selection_bypass_fires_above_threshold():
    """51-char selection clearly fires."""
    session = MagicMock()
    job = _make_job()
    text = "y" * 51
    fired = processor._try_selection_bypass(session, job, _meta(text))
    assert fired is True
    assert job.extracted_text == text


# ---------------------------------------------------------------------------
# Whitespace normalization
# ---------------------------------------------------------------------------
def test_selection_bypass_strips_whitespace_before_length_check():
    """Leading/trailing whitespace is stripped — 49 'x's surrounded by
    a newline still falls below threshold."""
    session = MagicMock()
    job = _make_job()
    text = "  " + ("x" * 49) + " \n "
    fired = processor._try_selection_bypass(session, job, _meta(text))
    assert fired is False


def test_selection_bypass_stores_stripped_text_at_50_chars():
    """Whitespace surrounding a 50-char body is stripped from the
    persisted merged_text."""
    session = MagicMock()
    job = _make_job()
    text = "\n  " + ("k" * 50) + "  \n"
    fired = processor._try_selection_bypass(session, job, _meta(text))
    assert fired is True
    assert job.extracted_text == "k" * 50
    assert job.extracted_metadata["selection_length"] == 50


# ---------------------------------------------------------------------------
# Title fallback
# ---------------------------------------------------------------------------
def test_selection_bypass_falls_back_to_hostname_when_no_page_title():
    """No page_title in metadata → use the hostname (better than the
    raw URL)."""
    session = MagicMock()
    job = _make_job()
    fired = processor._try_selection_bypass(
        session, job, _meta("k" * 60, page_title=""),
    )
    assert fired is True
    assert "newsis.com" in job.extracted_metadata.get("title", "")


def test_selection_bypass_uses_page_title_when_present():
    """A page_title from client_metadata wins over the URL host."""
    session = MagicMock()
    job = _make_job()
    fired = processor._try_selection_bypass(
        session, job, _meta("k" * 60, page_title="PO 기사 헤드라인"),
    )
    assert fired is True
    assert job.extracted_metadata["title"] == "PO 기사 헤드라인"


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------
def test_detect_language_bypass_korean():
    assert processor._detect_language_bypass("한국어 본문입니다." * 4) == "ko"


def test_detect_language_bypass_english():
    assert processor._detect_language_bypass(
        "this is purely english text" * 3,
    ) == "en"


def test_detect_language_bypass_mixed():
    assert processor._detect_language_bypass(
        "Mixed 한국어 with English text",
    ) == "mixed"


def test_detect_language_bypass_empty():
    assert processor._detect_language_bypass("") == "mixed"


# ---------------------------------------------------------------------------
# Missing selection_text behaves like a normal capture
# ---------------------------------------------------------------------------
def test_selection_bypass_absent_when_no_selection_text():
    """No selection_text key → bypass does NOT fire."""
    session = MagicMock()
    job = _make_job()
    metadata = {"source_url": "https://x"}
    fired = processor._try_selection_bypass(session, job, metadata)
    assert fired is False


def test_selection_bypass_absent_when_empty_selection_text():
    """Empty selection_text → bypass does NOT fire (back-compat with
    pre-PR captures that never set this key)."""
    session = MagicMock()
    job = _make_job()
    metadata = {"source_url": "https://x", "selection_text": ""}
    fired = processor._try_selection_bypass(session, job, metadata)
    assert fired is False
