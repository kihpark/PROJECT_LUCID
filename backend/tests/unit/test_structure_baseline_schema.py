"""Unit: baseline samples.json schema + distribution."""
from __future__ import annotations

import json
from pathlib import Path


def test_baseline_has_exactly_50_samples():
    p = Path(__file__).resolve().parents[1] / "baseline" / "samples.json"
    rows = json.loads(p.read_text(encoding="utf-8"))
    assert len(rows) == 50


def test_baseline_sample_schema():
    p = Path(__file__).resolve().parents[1] / "baseline" / "samples.json"
    rows = json.loads(p.read_text(encoding="utf-8"))
    required_keys = {
        "id", "lang", "category", "text", "expected_facts",
        "expected_negation_flags", "expected_negation_scope",
        "expected_status", "expected_failure_reason", "notes",
    }
    for row in rows:
        assert required_keys.issubset(row.keys()), f"missing in {row.get('id')}"
        assert row["lang"] in ("ko", "en")
        assert row["expected_status"] in ("success", "no_facts_found")


def test_baseline_id_uniqueness():
    p = Path(__file__).resolve().parents[1] / "baseline" / "samples.json"
    rows = json.loads(p.read_text(encoding="utf-8"))
    ids = [r["id"] for r in rows]
    assert len(set(ids)) == len(ids), "duplicate sample id"


def test_baseline_negation_distribution():
    """5 full + 3 partial + 2 ambiguous = 10 negation cases."""
    p = Path(__file__).resolve().parents[1] / "baseline" / "samples.json"
    rows = json.loads(p.read_text(encoding="utf-8"))
    full = [r for r in rows if r["category"] == "negation_full"]
    partial = [r for r in rows if r["category"] == "negation_partial"]
    ambiguous = [r for r in rows if r["category"] == "negation_ambiguous"]
    assert len(full) == 5
    assert len(partial) == 3
    assert len(ambiguous) == 2


def test_baseline_lang_balance():
    """Should be roughly balanced KO + EN (target 25/25, allow ±3 since
    multi-lang samples count toward one language by primary script)."""
    p = Path(__file__).resolve().parents[1] / "baseline" / "samples.json"
    rows = json.loads(p.read_text(encoding="utf-8"))
    ko = sum(1 for r in rows if r["lang"] == "ko")
    en = sum(1 for r in rows if r["lang"] == "en")
    assert ko + en == 50
    assert abs(ko - en) <= 6, f"KO/EN imbalance too large: {ko}/{en}"
