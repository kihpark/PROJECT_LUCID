"""feat/stage3-predicate-code-fact-type — fact_type 격하 dedup tests.

PO 의뢰서 STAGE 3: dedup key migrates from predicate_code (English
OPL) to fact_type (3종 bucket) + natural Korean/English predicate.
Verifies that:
  - facts with fact_type='claim' and the same (subject, predicate, object)
    collapse even when predicate_code differs.
  - facts with different fact_type buckets DO NOT collapse even when
    predicate is identical (action vs claim disambiguation).
  - the raw natural predicate (Korean) is the tie-breaker.
  - the legacy predicate_code fallback still works when fact_type is
    missing (legacy payload corpus).
"""
from __future__ import annotations

from api.structure.fact_dedup import _fact_key, dedup_facts


def test_same_fact_type_same_predicate_collapses():
    facts = [
        {"fact_uid": "fn-a", "subject_label": "삼성전자",
         "fact_type": "claim", "predicate": "밝혔다",
         "object_value": "투자 확대"},
        {"fact_uid": "fn-b", "subject_label": "삼성전자",
         "fact_type": "claim", "predicate": "밝혔다",
         "object_value": "투자 확대"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_different_fact_type_does_not_collapse():
    """A claim by 삼성 ≠ an action by 삼성 with the same surface."""
    facts = [
        {"fact_uid": "fn-claim", "subject_label": "삼성전자",
         "fact_type": "claim", "predicate": "발표했다",
         "object_value": "신제품"},
        {"fact_uid": "fn-action", "subject_label": "삼성전자",
         "fact_type": "action", "predicate": "발표했다",
         "object_value": "신제품"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2
    assert dropped == set()


def test_fact_type_takes_precedence_over_predicate_code():
    """When both are present, fact_type wins; predicate_code is ignored."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "fact_type": "claim", "predicate_code": "ANNOUNCES",
         "predicate": "주장했다", "object_value": "Y"},
        {"fact_uid": "fn-b", "subject_label": "X",
         "fact_type": "claim", "predicate_code": "RELATED_TO",
         "predicate": "주장했다", "object_value": "Y"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_legacy_predicate_code_fallback_when_fact_type_absent():
    """KIST scenario (PO live evidence) — no fact_type, predicate_code
    is the bucket fallback."""
    facts = [
        {"fact_uid": "e226de7d", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "14396d74", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"14396d74"}


def test_natural_predicate_normalizes_case_and_whitespace():
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "fact_type": "claim", "predicate": "밝혔다",
         "object_value": "Y"},
        {"fact_uid": "fn-b", "subject_label": "X",
         "fact_type": "claim", "predicate": "  밝혔다  ",
         "object_value": "Y"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_conjugation_variants_DO_NOT_collapse():
    """The PO accepts weak conjugation duplicates — there is NO
    dictionary / morphological reducer. '밝혔다' ≠ '밝혔습니다'."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "fact_type": "claim", "predicate": "밝혔다",
         "object_value": "Y"},
        {"fact_uid": "fn-b", "subject_label": "X",
         "fact_type": "claim", "predicate": "밝혔습니다",
         "object_value": "Y"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2


def test_fact_key_returns_4_tuple():
    fact = {"subject_label": "X", "fact_type": "claim",
            "predicate": "밝혔다", "object_value": "Y"}
    key = _fact_key(fact)
    assert len(key) == 4
    assert key == ("x", "claim", "밝혔다", "y")
