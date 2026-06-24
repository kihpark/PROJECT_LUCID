"""Integration tests for the contradiction writer + recall projection.

v0.2.0 step 3 of 3 (fact-contradiction-detection-v1).

Locks the wire shape:
  1. detect_and_persist writes CONTRADICTS rows into fact_relations
     using the real Postgres test DB (pg_session fixture).
  2. count_contradictions_for_facts surfaces the row counts back to
     the recall projection.
  3. Re-running detect_and_persist is idempotent (no duplicate rows).

The ES side is faked — we drive the detector with a list of fact docs
shaped exactly like real lucid_facts entries.
"""
from __future__ import annotations

from typing import Any

import pytest

pytestmark = pytest.mark.integration


class FakeES:
    """Minimal ES double — supports the single `search` shape the
    detector uses. Identical to the FakeES in the unit test file but
    duplicated to keep the two test files independent."""

    def __init__(self) -> None:
        self._docs: list[tuple[str, str, dict[str, Any]]] = []

    def add(self, ks_id: str, fact: dict[str, Any]) -> None:
        fact.setdefault("knowledge_space_id", ks_id)
        fact.setdefault("validation_method", "manual")
        fact_type = fact.get("fact_type") or "action"
        fact["fact_type"] = fact_type
        self._docs.append((ks_id, fact_type, fact))

    def search(self, *, index: str, size: int, query: dict[str, Any]) -> dict[str, Any]:
        filters = (query.get("bool") or {}).get("filter") or []
        must_not = (query.get("bool") or {}).get("must_not") or []
        ks_target: str | None = None
        type_target: str | None = None
        method_target: str | None = None
        for clause in filters:
            term = clause.get("term") or {}
            if "knowledge_space_id" in term:
                ks_target = term["knowledge_space_id"]
            if "fact_type" in term:
                type_target = term["fact_type"]
            if "validation_method" in term:
                method_target = term["validation_method"]
        drop_retracted = any(
            (c.get("exists") or {}).get("field") == "retracted_at"
            for c in must_not
        )
        hits = []
        for ks_id, fact_type, src in self._docs:
            if ks_target and ks_id != ks_target:
                continue
            if type_target and fact_type != type_target:
                continue
            if method_target and src.get("validation_method") != method_target:
                continue
            if drop_retracted and src.get("retracted_at"):
                continue
            hits.append({"_source": src})
        return {"hits": {"hits": hits[:size]}}


# ---------------------------------------------------------------------------
# 1. detect_and_persist writes real rows to fact_relations
# ---------------------------------------------------------------------------


def test_detect_and_persist_writes_contradicts_rows(pg_session) -> None:
    """A measurement contradiction lands as a CONTRADICTS row in the
    real Postgres test DB (via pg_session — alembic-upgraded schema)."""
    from api.storage.postgres.orm import FactRelation
    from api.structure.contradiction_detector import (
        CONTRADICTS,
        detect_and_persist,
    )

    es = FakeES()
    es.add("ks-test", {
        "fact_uid": "m1", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 8e8, "measurement_unit": "명",
    })
    es.add("ks-test", {
        "fact_uid": "m2", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 9e8, "measurement_unit": "명",
    })

    summary = detect_and_persist(es, pg_session, "ks-test")
    assert summary["candidates_found"] == 1
    assert summary["relations_written"] == 1
    assert summary["by_layer"]["measurement"] == 1
    assert summary["by_layer"]["action"] == 0

    rows = (
        pg_session.query(FactRelation)
        .filter(FactRelation.relation_type == CONTRADICTS)
        .all()
    )
    assert len(rows) == 1
    pair = {rows[0].from_fact_uid, rows[0].to_fact_uid}
    assert pair == {"m1", "m2"}


# ---------------------------------------------------------------------------
# 2. Idempotent re-run — second call writes nothing new
# ---------------------------------------------------------------------------


def test_detect_and_persist_idempotent_on_rerun(pg_session) -> None:
    """Running detect_and_persist twice on the same KS does NOT
    duplicate rows."""
    from api.storage.postgres.orm import FactRelation
    from api.structure.contradiction_detector import detect_and_persist

    es = FakeES()
    es.add("ks-iso", {
        "fact_uid": "a1", "fact_type": "action",
        "subject_uid": "s-1", "predicate_code": "JOINED_PARTY",
        "object_value": "party-A", "negation_flag": False,
    })
    es.add("ks-iso", {
        "fact_uid": "a2", "fact_type": "action",
        "subject_uid": "s-1", "predicate_code": "JOINED_PARTY",
        "object_value": "party-A", "negation_flag": True,
    })

    first = detect_and_persist(es, pg_session, "ks-iso")
    second = detect_and_persist(es, pg_session, "ks-iso")

    assert first["relations_written"] == 1
    assert second["relations_written"] == 0
    assert pg_session.query(FactRelation).count() == 1


# ---------------------------------------------------------------------------
# 3. Recall projection — count_contradictions_for_facts surfaces counts
# ---------------------------------------------------------------------------


def test_recall_count_contradictions_after_persist(pg_session) -> None:
    """detect_and_persist + count_contradictions_for_facts roundtrip:
    the count surfaced for each fact_uid matches the number of
    CONTRADICTS edges that touch it."""
    from api.structure.contradiction_detector import (
        count_contradictions_for_facts,
        detect_and_persist,
    )

    es = FakeES()
    # Three measurement facts in one bucket -> C(3,2)=3 candidate pairs.
    # f1 sits on TWO pairs (with f2 and f3); f2 / f3 each sit on TWO.
    # Actually each is on 2: f1-f2, f1-f3, f2-f3 => f1 in 2, f2 in 2, f3 in 2.
    for uid, val in [("f1", 1.0), ("f2", 2.0), ("f3", 3.0)]:
        es.add("ks-count", {
            "fact_uid": uid, "fact_type": "measurement",
            "metric": "Revenue", "subject_uid": "e-1", "as_of": "2026Q1",
            "measurement_value": val,
        })

    detect_and_persist(es, pg_session, "ks-count")

    counts = count_contradictions_for_facts(
        pg_session, ["f1", "f2", "f3", "missing-uid"],
    )
    assert counts["f1"] == 2
    assert counts["f2"] == 2
    assert counts["f3"] == 2
    assert counts.get("missing-uid", 0) == 0
