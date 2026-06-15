"""Unit tests for `_job_summary` (B-29 defect 1).

The pre-B-29 implementation used the raw `fact_count` from
`extracted_metadata["structure"]` so a job where the user had already
decided every fact still showed e.g. "facts 12" on the queue card.
The detail view, which DOES filter out decided facts, then showed
"0 pending fact(s)" — the visible inconsistency PO flagged.

The fix is to compute the pending count from
`facts_summary` minus `decided_fact_uids` inside `_job_summary`. These
tests pin that contract.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from api.routes.validate import _job_summary


def _mock_job(structure: dict, *, source_url: str = "https://example.com/x") -> MagicMock:
    job = MagicMock()
    job.id = uuid.uuid4()
    job.source_url = source_url
    job.source_type = "web_article"
    job.captured_at = datetime(2026, 6, 15, 9, 0, tzinfo=UTC)
    job.captured_from = "chrome_ext"
    job.extracted_metadata = {"structure": structure}
    return job


@pytest.fixture
def three_facts_structure():
    """Three undecided facts, no decisions yet."""
    return {
        "fact_count": 3,
        "object_count": 1,
        "object_disambig_pending": 0,
        "facts_summary": [
            {"fact_uid": "fn-1", "uid": "fn-1", "negation_flag": False},
            {"fact_uid": "fn-2", "uid": "fn-2", "negation_flag": True},
            {"fact_uid": "fn-3", "uid": "fn-3", "negation_flag": False},
        ],
    }


def test_job_summary_with_no_decisions_returns_total(three_facts_structure):
    """Baseline: no decided_fact_uids -> fact_count is the structure total."""
    job = _mock_job(three_facts_structure)
    s = _job_summary(job)
    assert s.fact_count == 3
    assert s.has_negation is True  # fn-2 carries the flag


def test_job_summary_subtracts_decided_from_total(three_facts_structure):
    """Half decided -> fact_count is the pending half."""
    three_facts_structure["decided_fact_uids"] = ["fn-1"]
    job = _mock_job(three_facts_structure)
    s = _job_summary(job)
    assert s.fact_count == 2
    # fn-2 still pending and still carries the negation flag
    assert s.has_negation is True


def test_job_summary_returns_zero_when_all_decided(three_facts_structure):
    """Every fact decided -> fact_count == 0. (list_pending filters
    these out, but the summary itself must still report accurately.)"""
    three_facts_structure["decided_fact_uids"] = ["fn-1", "fn-2", "fn-3"]
    job = _mock_job(three_facts_structure)
    s = _job_summary(job)
    assert s.fact_count == 0
    # Negation badge drops when no pending fact carries the flag
    assert s.has_negation is False


def test_job_summary_decided_set_lookup_uses_fact_uid_or_uid(three_facts_structure):
    """`fact_summary` entries written before chore-5 only had a `uid`
    key; entries since chore-5 carry both `uid` and `fact_uid`. The
    decided-set membership check must accept either."""
    three_facts_structure["facts_summary"] = [
        {"uid": "fn-legacy", "negation_flag": False},
        {"fact_uid": "fn-new", "uid": "fn-new", "negation_flag": False},
    ]
    three_facts_structure["fact_count"] = 2
    three_facts_structure["decided_fact_uids"] = ["fn-legacy"]
    job = _mock_job(three_facts_structure)
    s = _job_summary(job)
    assert s.fact_count == 1


def test_job_summary_falls_back_when_facts_summary_missing(three_facts_structure):
    """A job with no `facts_summary` key (older row) reports
    `fact_count` directly. We accept the older shape because it was
    valid at the time of write."""
    del three_facts_structure["facts_summary"]
    # No decided either — pure pass-through.
    job = _mock_job(three_facts_structure)
    s = _job_summary(job)
    assert s.fact_count == 3
