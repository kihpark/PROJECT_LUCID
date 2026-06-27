"""STAGE 2 SPO dedup verify — new-capture sim (PO 의뢰서 verbatim).

PO acceptance (2026-06-27, STAGE 2):
  1. 같은 R&D 기사 재캡처 → "KIST 세부과제 이끈다" Decide 에 1번만.
  2. 다른 정상 fact 는 안 합쳐짐(과병합 0).

A live re-capture round-trip needs Chrome extension + LLM, which the
test harness cannot drive. So we simulate the *write boundary* — the
exact ``facts_payload`` shape ``_serialize_struct_fact`` writes into
``extracted_metadata.structure.facts`` — and feed it through
``dedup_facts`` (the function the structure stage calls at line 974
of processor.py). If dedup behaves as PO needs, every new capture
that lands the same canonical SPO tuple will collapse to one Decide
row regardless of how many times the LLM multi-emits.

This sits in ``tests/integration/`` (not unit) because it pins the
end-to-end *contract* between processor.py's payload shape and the
dedup function — a regression in either side breaks the contract,
which is exactly what STAGE 2 must guard.
"""
from __future__ import annotations

import pytest

from api.structure.fact_dedup import dedup_facts


def _fact(
    *,
    fact_uid: str,
    subject_label: str | None = None,
    subject_uid: str | None = None,
    predicate_code: str | None = "RELATED_TO",
    predicate: str | None = None,
    object_label: str | None = None,
    object_value: str | None = None,
    claim: str | None = None,
) -> dict:
    """Build one facts_payload dict matching the on-disk shape.

    Only the keys ``dedup_facts`` reads (subject_label/uid,
    predicate_code/predicate, object_label/value, fact_uid/uid) are
    required for the dedup contract; ``claim`` is included for
    realistic verisimilitude when a test wants to confirm the same
    tuple can have different surface text.
    """
    d: dict = {"fact_uid": fact_uid, "uid": fact_uid}
    if subject_label is not None:
        d["subject_label"] = subject_label
    if subject_uid is not None:
        d["subject_uid"] = subject_uid
    if predicate_code is not None:
        d["predicate_code"] = predicate_code
    if predicate is not None:
        d["predicate"] = predicate
    if object_label is not None:
        d["object_label"] = object_label
    if object_value is not None:
        d["object_value"] = object_value
    if claim is not None:
        d["claim"] = claim
    return d


def test_acceptance_1_kist_4dup_collapses_to_unique_pair():
    """PO live job 3bab7b79: 4 facts, 4 dups -> 2 unique survive.

    Mirrors the exact PO evidence in the dedup module docstring.
    The re-capture sim: even if the LLM emits "KIST 세부과제 이끈다"
    twice (and KETI twice), the Decide overlay sees one row per
    canonical (subject, RELATED_TO, None) tuple.
    """
    facts = [
        _fact(
            fact_uid="e226de7d", subject_label="KIST",
            predicate_code="RELATED_TO",
            claim="KIST가 세부과제를 이끈다",
        ),
        _fact(
            fact_uid="c531cb29", subject_label="KETI",
            predicate_code="RELATED_TO",
            claim="KETI가 세부과제를 이끈다",
        ),
        _fact(
            fact_uid="dfcd265a", subject_label="KETI",
            predicate_code="RELATED_TO",
            claim="KETI가 다른 세부과제를 이끈다",
        ),
        _fact(
            fact_uid="14396d74", subject_label="KIST",
            predicate_code="RELATED_TO",
            claim="KIST가 또다른 세부과제를 이끈다",
        ),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2, (
        "PO acceptance 1: same SPO must collapse to 1 Decide row"
    )
    survivors = [f["fact_uid"] for f in kept]
    assert survivors == ["e226de7d", "c531cb29"]
    assert dropped == {"dfcd265a", "14396d74"}


def test_acceptance_1_recapture_identical_payload_idempotent():
    """Re-capturing the same article twice in a row must not double-emit.

    Simulates the realistic re-capture: LLM emits the same canonical
    tuple twice across two paragraphs that say the same thing in
    slightly different wording. Decide sees one row.
    """
    facts = [
        _fact(
            fact_uid="cap1-a", subject_label="KIST",
            predicate_code="LEADS",
            object_label="세부과제",
            claim="KIST가 세부과제를 이끈다",
        ),
        _fact(
            fact_uid="cap2-a", subject_label="KIST",
            predicate_code="LEADS",
            object_label="세부과제",
            claim="KIST가 세부과제를 주도한다",
        ),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert kept[0]["fact_uid"] == "cap1-a"
    assert dropped == {"cap2-a"}


def test_acceptance_2_distinct_subjects_not_overmerged():
    """KIST vs KETI vs 한은 — three distinct subjects survive intact."""
    facts = [
        _fact(fact_uid="fn-1", subject_label="KIST",
              predicate_code="LEADS", object_label="ProjA"),
        _fact(fact_uid="fn-2", subject_label="KETI",
              predicate_code="LEADS", object_label="ProjA"),
        _fact(fact_uid="fn-3", subject_label="한국은행",
              predicate_code="LEADS", object_label="ProjA"),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 3, "distinct subjects must not collapse"
    assert dropped == set()


def test_acceptance_2_distinct_predicates_not_overmerged():
    """Same subject + object, different predicate -> two facts survive.

    KIST LEADS ProjA vs KIST FUNDED ProjA are different claims.
    """
    facts = [
        _fact(fact_uid="fn-1", subject_label="KIST",
              predicate_code="LEADS", object_label="ProjA"),
        _fact(fact_uid="fn-2", subject_label="KIST",
              predicate_code="FUNDED", object_label="ProjA"),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2
    assert dropped == set()


def test_acceptance_2_distinct_objects_not_overmerged():
    """Same subject + predicate, different object -> two facts survive."""
    facts = [
        _fact(fact_uid="fn-1", subject_label="KIST",
              predicate_code="LEADS", object_label="ProjA"),
        _fact(fact_uid="fn-2", subject_label="KIST",
              predicate_code="LEADS", object_label="ProjB"),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2
    assert dropped == set()


def test_llm_multi_emit_same_claim_different_subjects_kept():
    """LLM multi-emit pattern: identical claim text but distinct
    subject parses -> both kept (the dedup key is SPO, not claim).

    Realistic case: same article paragraph mentions "양 기관이 협력한다"
    and the decomposer splits it into two facts subject=KIST and
    subject=KETI. Same claim string, different SPO tuples -> both
    survive (otherwise the Decide overlay would lose one party of a
    cooperation fact).
    """
    facts = [
        _fact(
            fact_uid="multi-a", subject_label="KIST",
            predicate_code="COOPERATES_WITH",
            object_label="KETI",
            claim="양 기관이 협력한다",
        ),
        _fact(
            fact_uid="multi-b", subject_label="KETI",
            predicate_code="COOPERATES_WITH",
            object_label="KIST",
            claim="양 기관이 협력한다",
        ),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2, (
        "same claim, different SPO must NOT collapse (과병합 0)"
    )
    assert dropped == set()


def test_llm_multi_emit_same_spo_different_claims_collapses():
    """Inverse: different claim strings, identical SPO tuple -> 1.

    Pattern PO saw in 3bab7b79: paragraph 1 says "KIST가 이끈다",
    paragraph 4 says "KIST가 주도한다", but the SPO both reduce to
    (KIST, RELATED_TO, None) under the OPL mapper.
    """
    facts = [
        _fact(
            fact_uid="surf-1", subject_label="KIST",
            predicate_code="RELATED_TO",
            claim="KIST가 세부과제를 이끈다",
        ),
        _fact(
            fact_uid="surf-2", subject_label="KIST",
            predicate_code="RELATED_TO",
            claim="KIST가 세부과제를 주도한다",
        ),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"surf-2"}


def test_mixed_payload_dedups_only_true_duplicates():
    """A realistic 8-fact payload: 4 RELATED_TO dups (KIST x2, KETI x2)
    interleaved with 4 distinct LEADS facts. Expected: 6 survive
    (2 dedup pairs collapsed) and no LEADS fact is dropped.
    """
    facts = [
        _fact(fact_uid="fn-1", subject_label="KIST",
              predicate_code="LEADS", object_label="과제1"),
        _fact(fact_uid="fn-2", subject_label="KIST",
              predicate_code="RELATED_TO"),
        _fact(fact_uid="fn-3", subject_label="KETI",
              predicate_code="LEADS", object_label="과제2"),
        _fact(fact_uid="fn-4", subject_label="KETI",
              predicate_code="RELATED_TO"),
        _fact(fact_uid="fn-5", subject_label="KIST",
              predicate_code="LEADS", object_label="과제3"),
        _fact(fact_uid="fn-6", subject_label="KIST",
              predicate_code="RELATED_TO"),
        _fact(fact_uid="fn-7", subject_label="KETI",
              predicate_code="LEADS", object_label="과제4"),
        _fact(fact_uid="fn-8", subject_label="KETI",
              predicate_code="RELATED_TO"),
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 6
    assert dropped == {"fn-6", "fn-8"}
    leads_uids = [
        f["fact_uid"] for f in kept
        if f.get("predicate_code") == "LEADS"
    ]
    assert sorted(leads_uids) == ["fn-1", "fn-3", "fn-5", "fn-7"]


pytestmark = pytest.mark.integration
