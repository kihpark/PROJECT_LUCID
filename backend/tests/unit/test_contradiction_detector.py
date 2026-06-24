"""Unit tests for api.structure.contradiction_detector.

v0.2.0 step 3 of 3 (fact-contradiction-detection-v1) — detection-only.
Rule-based scan over the measurement + action layers; no LLM, no
auto-resolution. Tests use a fake ES client (no Postgres / no ES) for
the detect pass; the persistence + count helpers are exercised against
a hand-built SQLAlchemy in-memory session inside conftest.

KEEP VERBATIM rule: keys are extracted as-is. No Levenshtein, no
case-folding, no unit normalisation. False negatives are accepted in
the first pass.
"""
from __future__ import annotations

from typing import Any

import pytest

from api.structure.contradiction_detector import (
    CONTRADICTS,
    ContradictionCandidate,
    _action_key,
    _measurement_key,
    count_contradictions_for_facts,
    detect_contradictions_in_ks,
    write_contradiction_relations,
)

# ---------------------------------------------------------------------------
# Fake ES client.
# ---------------------------------------------------------------------------


class FakeES:
    """Minimal ES double — supports the single `search` shape the detector
    uses. Stores docs by (ks_id, fact_type); `search` filters by both."""

    def __init__(self) -> None:
        # list of (ks_id, fact_type, source dict)
        self._docs: list[tuple[str, str, dict[str, Any]]] = []

    def add(self, ks_id: str, fact: dict[str, Any]) -> None:
        # Populate the canonical-looking shape; defaults that always pass.
        fact.setdefault("knowledge_space_id", ks_id)
        fact.setdefault("validation_method", "manual")
        fact_type = fact.get("fact_type") or "action"
        fact["fact_type"] = fact_type
        self._docs.append((ks_id, fact_type, fact))

    def search(self, *, index: str, size: int, query: dict[str, Any]) -> dict[str, Any]:
        # Parse the bool/filter clauses we know the detector emits.
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
        # `must_not exists retracted_at` — we just refuse hits that have
        # retracted_at set.
        drop_retracted = any(
            (clause.get("exists") or {}).get("field") == "retracted_at"
            for clause in must_not
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
# Key extractor tests.
# ---------------------------------------------------------------------------


def test_measurement_key_all_three_required() -> None:
    """Drops a measurement fact missing any of metric / entity / as_of."""
    assert _measurement_key(
        {"metric": "MAU", "subject_uid": "e-1", "as_of": "2026"}
    ) == ("MAU", "e-1", "2026")
    assert _measurement_key({"metric": "MAU", "subject_uid": "e-1"}) is None
    assert _measurement_key({"metric": "", "subject_uid": "e-1", "as_of": "2026"}) is None
    # speaker_uid is the fallback when subject_uid is absent
    assert _measurement_key(
        {"metric": "MAU", "speaker_uid": "s-1", "as_of": "2026"}
    ) == ("MAU", "s-1", "2026")


def test_action_key_requires_predicate_code() -> None:
    """Pre-OPL legacy facts (no predicate_code) are skipped."""
    assert _action_key(
        {"subject_uid": "s-1", "predicate_code": "VISITED", "object_value": "Paris"}
    ) == ("s-1", "VISITED", "Paris")
    # object_canonical wins over surface object_value when present
    assert _action_key(
        {
            "subject_uid": "s-1",
            "predicate_code": "VISITED",
            "object_canonical": "entity-uuid",
            "object_value": "Paris",
        }
    ) == ("s-1", "VISITED", "entity-uuid")
    # Missing predicate_code -> None (legacy facts excluded)
    assert _action_key(
        {"subject_uid": "s-1", "predicate": "방문했다", "object_value": "Paris"}
    ) is None


# ---------------------------------------------------------------------------
# Measurement-layer detection.
# ---------------------------------------------------------------------------


def test_measurement_same_key_different_value_flags_one_pair() -> None:
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "m1", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 8e8, "measurement_unit": "명",
    })
    es.add("ks-A", {
        "fact_uid": "m2", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 9e8, "measurement_unit": "명",
    })
    candidates = detect_contradictions_in_ks(es, "ks-A")
    assert len(candidates) == 1
    c = candidates[0]
    assert c.layer == "measurement"
    assert {c.from_fact_uid, c.to_fact_uid} == {"m1", "m2"}
    assert c.evidence["value_a"] == 8e8
    assert c.evidence["value_b"] == 9e8


def test_measurement_same_metric_different_as_of_no_pair() -> None:
    """Same metric + entity but DIFFERENT as_of buckets: not a contradiction
    (different timepoint = legitimate time series, not a conflict)."""
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "m1", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2025",
        "measurement_value": 7e8,
    })
    es.add("ks-A", {
        "fact_uid": "m2", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 9e8,
    })
    assert detect_contradictions_in_ks(es, "ks-A") == []


def test_measurement_same_key_same_value_no_pair() -> None:
    """Identical key AND identical value = corroboration, not contradiction."""
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "m1", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 8e8,
    })
    es.add("ks-A", {
        "fact_uid": "m2", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 8e8,
    })
    assert detect_contradictions_in_ks(es, "ks-A") == []


def test_measurement_three_distinct_values_emit_three_pairs() -> None:
    """Three facts in the same bucket with three distinct values =
    C(3,2)=3 pairwise candidates."""
    es = FakeES()
    for uid, val in [("m1", 8e8), ("m2", 9e8), ("m3", 1.0e9)]:
        es.add("ks-A", {
            "fact_uid": uid, "fact_type": "measurement",
            "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
            "measurement_value": val,
        })
    candidates = detect_contradictions_in_ks(es, "ks-A")
    assert len(candidates) == 3
    pairs = {frozenset({c.from_fact_uid, c.to_fact_uid}) for c in candidates}
    assert pairs == {
        frozenset({"m1", "m2"}),
        frozenset({"m1", "m3"}),
        frozenset({"m2", "m3"}),
    }


# ---------------------------------------------------------------------------
# Action-layer detection.
# ---------------------------------------------------------------------------


def test_action_same_spo_polarity_flip_flags_one_pair() -> None:
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "a1", "fact_type": "action",
        "subject_uid": "s-1", "predicate_code": "JOINED_PARTY",
        "object_value": "party-A", "negation_flag": False,
    })
    es.add("ks-A", {
        "fact_uid": "a2", "fact_type": "action",
        "subject_uid": "s-1", "predicate_code": "JOINED_PARTY",
        "object_value": "party-A", "negation_flag": True,
    })
    candidates = detect_contradictions_in_ks(es, "ks-A")
    assert len(candidates) == 1
    assert candidates[0].layer == "action"
    assert candidates[0].evidence == {
        "fact_a_negation": False, "fact_b_negation": True,
    }


def test_action_same_spo_same_polarity_no_pair() -> None:
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "a1", "fact_type": "action",
        "subject_uid": "s-1", "predicate_code": "JOINED_PARTY",
        "object_value": "party-A", "negation_flag": True,
    })
    es.add("ks-A", {
        "fact_uid": "a2", "fact_type": "action",
        "subject_uid": "s-1", "predicate_code": "JOINED_PARTY",
        "object_value": "party-A", "negation_flag": True,
    })
    assert detect_contradictions_in_ks(es, "ks-A") == []


def test_action_missing_predicate_code_skipped() -> None:
    """Legacy pre-OPL facts (no predicate_code) cannot be keyed and are
    silently excluded — no candidate emitted."""
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "a1", "fact_type": "action",
        "subject_uid": "s-1", "predicate": "방문했다",
        "object_value": "Paris", "negation_flag": False,
    })
    es.add("ks-A", {
        "fact_uid": "a2", "fact_type": "action",
        "subject_uid": "s-1", "predicate": "방문했다",
        "object_value": "Paris", "negation_flag": True,
    })
    assert detect_contradictions_in_ks(es, "ks-A") == []


# ---------------------------------------------------------------------------
# Cross-KS isolation.
# ---------------------------------------------------------------------------


def test_cross_ks_facts_never_compared() -> None:
    """Two contradictory measurements that happen to share a key but live
    in different KS produce ZERO candidates."""
    es = FakeES()
    es.add("ks-A", {
        "fact_uid": "m1", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 8e8,
    })
    es.add("ks-B", {
        "fact_uid": "m2", "fact_type": "measurement",
        "metric": "MAU", "subject_uid": "e-1", "as_of": "2026",
        "measurement_value": 9e8,
    })
    assert detect_contradictions_in_ks(es, "ks-A") == []
    assert detect_contradictions_in_ks(es, "ks-B") == []


# ---------------------------------------------------------------------------
# Persistence — idempotent + symmetric writes.
# ---------------------------------------------------------------------------


@pytest.fixture()
def pg_session_in_memory():
    """Spin up an in-memory SQLite engine with the Base.metadata schema.

    fact_relations is the only table the detector writes to; Postgres
    UUID server-defaults work under SQLite because mapped_column carries
    Python defaults via `gen_random_uuid()` at the DB layer only — for
    UUID PK we omit the column and SQLAlchemy lets SQLite generate one
    only if the column has a Python default. We provide one via a hook
    on FactRelation insert.
    """
    pytest.importorskip("sqlalchemy")
    import uuid as _uuid

    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker

    from api.storage.postgres.orm import Base, FactRelation  # noqa: F401

    engine = create_engine("sqlite:///:memory:")

    # SQLite has no gen_random_uuid(); patch the PK at insert-time.
    @event.listens_for(FactRelation, "before_insert")
    def _seed_pk(mapper, connection, target):  # noqa: ANN001
        if target.relation_id is None:
            target.relation_id = _uuid.uuid4()

    # Build only the tables we need — avoid pulling unrelated PG-only
    # types (the FactRelation table is plain enough that SQLite accepts
    # it directly).
    FactRelation.__table__.create(bind=engine)

    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def test_write_persists_new_relations(pg_session_in_memory) -> None:
    from api.storage.postgres.orm import FactRelation

    candidates = [
        ContradictionCandidate(
            layer="measurement",
            from_fact_uid="m1",
            to_fact_uid="m2",
            key_summary="m1↔m2",
        ),
    ]
    written = write_contradiction_relations(pg_session_in_memory, candidates)
    assert written == 1
    rows = pg_session_in_memory.query(FactRelation).all()
    assert len(rows) == 1
    assert rows[0].relation_type == CONTRADICTS


def test_write_idempotent_same_pair_zero_on_rerun(pg_session_in_memory) -> None:
    """A second call with the same candidate emits 0 new rows."""
    from api.storage.postgres.orm import FactRelation

    candidates = [
        ContradictionCandidate(
            layer="action",
            from_fact_uid="a1",
            to_fact_uid="a2",
            key_summary="a1↔a2",
        ),
    ]
    write_contradiction_relations(pg_session_in_memory, candidates)
    again = write_contradiction_relations(pg_session_in_memory, candidates)
    assert again == 0
    assert pg_session_in_memory.query(FactRelation).count() == 1


def test_write_symmetric_dedup_against_reversed_pair(pg_session_in_memory) -> None:
    """write(a→b) then write(b→a) writes zero — the reverse pair already
    exists from the first call, so the second is a no-op."""
    from api.storage.postgres.orm import FactRelation

    write_contradiction_relations(
        pg_session_in_memory,
        [ContradictionCandidate(
            layer="measurement",
            from_fact_uid="x",
            to_fact_uid="y",
            key_summary="x↔y",
        )],
    )
    again = write_contradiction_relations(
        pg_session_in_memory,
        [ContradictionCandidate(
            layer="measurement",
            from_fact_uid="y",
            to_fact_uid="x",
            key_summary="y↔x",
        )],
    )
    assert again == 0
    assert pg_session_in_memory.query(FactRelation).count() == 1


def test_count_contradictions_for_facts_bulk_count(pg_session_in_memory) -> None:
    """One DB query returns per-uid counts for an arbitrary page."""
    write_contradiction_relations(
        pg_session_in_memory,
        [
            ContradictionCandidate(
                layer="measurement", from_fact_uid="f1", to_fact_uid="f2",
                key_summary="",
            ),
            ContradictionCandidate(
                layer="measurement", from_fact_uid="f1", to_fact_uid="f3",
                key_summary="",
            ),
        ],
    )
    counts = count_contradictions_for_facts(
        pg_session_in_memory, ["f1", "f2", "f3", "f4"],
    )
    assert counts.get("f1", 0) == 2
    assert counts.get("f2", 0) == 1
    assert counts.get("f3", 0) == 1
    assert counts.get("f4", 0) == 0
