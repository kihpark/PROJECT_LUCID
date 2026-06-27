"""Unit: ops/structure_dedup_audit — read-only KS dedup audit.

The CLI's *integration* surface (Postgres + every SourceJob in the
KS) is exercised in tests/integration/test_stage2_capture_dedup.py
via the dedup contract; here we pin the pure logic — extraction of
the facts list from extracted_metadata, aggregation of counts, and
the text rendering — without touching the DB.
"""
from __future__ import annotations

from api.ops.structure_dedup_audit import (
    _extract_facts,
    _format_report,
)


# ---------------------------------------------------------------------------
# _extract_facts — defensive shape handling
# ---------------------------------------------------------------------------

def test_extract_facts_returns_empty_for_none():
    """No metadata -> no facts (clean job)."""
    assert _extract_facts(None) == []


def test_extract_facts_returns_empty_for_non_dict():
    """Defensive: a stray non-dict on disk does not crash the audit."""
    assert _extract_facts("garbage") == []
    assert _extract_facts(42) == []


def test_extract_facts_returns_empty_when_structure_missing():
    """Pre-structure job (status=extracted, no structure stamp yet)."""
    assert _extract_facts({"extract": {"text": "..."}}) == []


def test_extract_facts_returns_empty_when_structure_not_dict():
    """Defensive: structure key present but wrong shape."""
    assert _extract_facts({"structure": "broken"}) == []
    assert _extract_facts({"structure": None}) == []


def test_extract_facts_returns_empty_when_facts_not_list():
    """Defensive: facts present but wrong shape (e.g. legacy dict)."""
    assert _extract_facts({"structure": {"facts": "wrong"}}) == []
    assert _extract_facts({"structure": {"facts": {"a": 1}}}) == []


def test_extract_facts_returns_the_list_when_well_formed():
    """Happy path — the audit reads exactly the on-disk list."""
    facts = [
        {"fact_uid": "fn-1", "subject_label": "KIST"},
        {"fact_uid": "fn-2", "subject_label": "KETI"},
    ]
    out = _extract_facts({"structure": {"facts": facts, "fact_count": 2}})
    assert out is facts  # not a copy — read-only audit, no mutation


# ---------------------------------------------------------------------------
# _format_report — text rendering stays grep-friendly
# ---------------------------------------------------------------------------

def test_format_report_empty_audit_says_clean():
    """Zero dups -> friendly all-clean line."""
    result = {
        "ks_id": "ks-x",
        "total_jobs_scanned": 5,
        "total_jobs_with_facts": 4,
        "total_jobs_with_dups": 0,
        "total_facts": 20,
        "total_dups_detected": 0,
        "dup_ratio": 0.0,
        "jobs_with_dups": [],
        "jobs_with_dups_total_listed": 0,
        "jobs_with_dups_truncated": 0,
    }
    text = _format_report(result)
    assert "total_jobs_scanned: 5" in text
    assert "total_dups_detected: 0" in text
    assert "pipeline output is clean" in text
    assert "Backfill is gated on PO command" in text


def test_format_report_with_jobs_renders_per_job_lines():
    """Per-job lines include job_id, fact_count, dup_count, source_url."""
    result = {
        "ks_id": "ks-y",
        "total_jobs_scanned": 3,
        "total_jobs_with_facts": 2,
        "total_jobs_with_dups": 2,
        "total_facts": 14,
        "total_dups_detected": 4,
        "dup_ratio": 0.286,
        "jobs_with_dups": [
            {
                "job_id": "3bab7b79-3fdc-4a87-a9ec-5e7273e76847",
                "source_url": "https://news.example.com/article-1",
                "fact_count": 14,
                "dup_count": 4,
                "dup_uids": ["14396d74", "dfcd265a"],
            },
            {
                "job_id": "44440000-0000-0000-0000-000000000000",
                "source_url": "https://news.example.com/article-2",
                "fact_count": 6,
                "dup_count": 1,
                "dup_uids": ["fn-x"],
            },
        ],
        "jobs_with_dups_total_listed": 2,
        "jobs_with_dups_truncated": 0,
    }
    text = _format_report(result)
    assert "ks_id: ks-y" in text
    assert "total_dups_detected: 4" in text
    assert "dup_ratio: 0.286" in text
    assert "job_id=3bab7b79-3fdc-4a87-a9ec-5e7273e76847" in text
    assert "facts=14 dups=4" in text
    assert "https://news.example.com/article-1" in text
    assert "14396d74" in text
    assert "facts=6 dups=1" in text


def test_format_report_announces_truncation():
    """When > top jobs have dups, the footer shows the truncation count."""
    result = {
        "ks_id": "ks-z",
        "total_jobs_scanned": 50,
        "total_jobs_with_facts": 50,
        "total_jobs_with_dups": 25,
        "total_facts": 200,
        "total_dups_detected": 60,
        "dup_ratio": 0.3,
        "jobs_with_dups": [
            {
                "job_id": f"job-{i:02d}",
                "source_url": f"https://example.com/{i}",
                "fact_count": 8,
                "dup_count": 2,
                "dup_uids": [f"u-{i}"],
            }
            for i in range(10)
        ],
        "jobs_with_dups_total_listed": 10,
        "jobs_with_dups_truncated": 15,
    }
    text = _format_report(result)
    assert "+15 more jobs with dups" in text
    assert "raise --top" in text

