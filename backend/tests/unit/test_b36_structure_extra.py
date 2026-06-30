"""B-36 defect 1 regression: StructureFact + StructureFactFactLink
silently drop unrecognized fields the LLM may emit.

The PO's reproduction case (einfomax 4420294, "스페이스X 커서 인수")
landed in the DB with extraction_status='no_facts_found' and
failure_reason='malformed_llm_output' even though the LLM produced a
2969-token response. Backend log showed 12 Pydantic validation errors:

  - facts.{0,10,12,13}.valid_from -> extra_forbidden
  - fact_fact_links.{0..7}.properties -> extra_forbidden

`valid_from` was retired from the schema by DR-053 but the prompt's
Step 7 was still asking the LLM to emit it, and StructureFactFactLink
never accepted `properties` (the LLM seems to copy the field over
from the FactObject link shape). This PR loosens the structure-stage
inner models to `extra='ignore'` so unknown LLM keys are dropped on
the floor — the persistence layer (FactNode et al.) keeps
`extra='forbid'`, so the DR-053 guarantee at the graph layer is
unchanged.
"""
from __future__ import annotations

from api.structure.models import (
    StructureFact,
    StructureFactFactLink,
    StructureResult,
)

# A condensed slice of the actual LLM output that landed PO's job
# d016576b in malformed_llm_output. Reduced to two facts (with the
# retired `valid_from` key) and two ff_links (with the unrecognized
# `properties` key).
EINFOMAX_LLM_PAYLOAD = {
    "objects": [
        {"uid": "obj-1", "class": "organization", "name": "SpaceX",
         "name_en": "SpaceX", "properties": {}},
        {"uid": "obj-2", "class": "organization", "name": "Cursor",
         "name_en": "Cursor", "properties": {}},
    ],
    "facts": [
        {
            "uid": "fn-1",
            "type": "proposition",
            "claim": "SpaceX 가 커서를 600억달러에 인수하기로 했다.",
            "subject_uid": "obj-1",
            "predicate": "acquired",
            "object_value": "obj-2",
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": ["IPO", "M&A"],
            # B-36 root cause: DR-053-retired field that the prompt
            # used to request. Schema must silently drop it.
            "valid_from": "2025-01-16",
        },
        {
            "uid": "fn-2",
            "type": "proposition",
            "claim": "SpaceX 주식 교환 방식으로 거래가 성사됐다.",
            "subject_uid": "obj-1",
            "predicate": "uses_method",
            "object_value": "주식 교환",
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": ["M&A"],
            "valid_from": "2025-01-16T07:42:00",
            # ★ STAGE 1c-vii: 발화 내용 / 거래 방법은 CLAIM 의도 의
            # literal 이므로 fact_type=claim 명시 (default action 은 raise).
            "fact_type": "claim",
        },
    ],
    "fact_object_links": [
        {"fact_uid": "fn-1", "object_uid": "obj-1",
         "link_type": "involves", "properties": {}},
    ],
    "fact_fact_links": [
        # B-36 second root cause: LLM emits `properties` on Fact->Fact
        # links by analogy with Fact->Object links. Schema must drop.
        {"from_uid": "fn-2", "to_uid": "fn-1",
         "link_type": "supports", "properties": {}},
    ],
    "disambiguation_candidates": [],
    "extraction_status": "success",
    "failure_reason": None,
}


def test_structure_fact_drops_valid_from_silently():
    # ★ STAGE 1c-vii: ACTION + literal "o" → raise. fact_type=claim 으로
    # 우회해 ``extra="ignore"`` 가 valid_from 을 drop 하는 behaviour 만 검증.
    f = StructureFact.model_validate(
        {
            "uid": "fn-1",
            "type": "proposition",
            "claim": "c",
            "subject_uid": "obj-1",
            "predicate": "p",
            "object_value": "o",
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": [],
            "valid_from": "2025-01-16",
            "fact_type": "claim",
        },
    )
    assert f.uid == "fn-1"
    # The retired field doesn't reach the model attribute surface.
    assert not hasattr(f, "valid_from") or getattr(f, "valid_from", None) is None


def test_structure_fact_drops_unknown_future_field():
    """Future-proofing: a brand-new key the LLM invents must also
    drop, not crash.

    ★ STAGE 1c-vii: ACTION + literal "o" → raise; fact_type=claim 으로
    우회해 extra-key drop behaviour 만 검증.
    """
    f = StructureFact.model_validate(
        {
            "uid": "fn-1",
            "type": "proposition",
            "claim": "c",
            "subject_uid": "obj-1",
            "predicate": "p",
            "object_value": "o",
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": [],
            "confidence": 0.9,
            "source_quote": "hallucinated key",
            "fact_type": "claim",
        },
    )
    assert f.uid == "fn-1"


def test_fact_fact_link_drops_properties_silently():
    """The PO's reproduction: LLM emits `properties: {}` on every
    fact-fact link. Schema accepts and drops."""
    link = StructureFactFactLink.model_validate(
        {
            "from_uid": "fn-1",
            "to_uid": "fn-2",
            "link_type": "supports",
            "properties": {},
        },
    )
    assert link.from_uid == "fn-1"
    assert link.link_type == "supports"


def test_structure_result_validates_einfomax_shaped_payload():
    """End-to-end regression on the actual LLM shape that broke PO's
    einfomax job. Before B-36 this raised 12 validation errors and
    the route fell back to no_facts_found. Now it parses cleanly."""
    result = StructureResult.model_validate(EINFOMAX_LLM_PAYLOAD)
    assert result.extraction_status == "success"
    assert len(result.facts) == 2
    assert result.facts[0].uid == "fn-1"
    assert result.facts[0].claim.startswith("SpaceX 가 커서를")
    assert result.facts[1].uid == "fn-2"
    assert len(result.fact_fact_links) == 1
    assert result.fact_fact_links[0].link_type == "supports"


def test_structure_result_silent_drop_preserves_strict_fields():
    """The model still rejects bad shapes for fields it DOES know
    about — `extra='ignore'` only loosens the closed-world side, it
    doesn't turn off type validation on declared fields."""
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        StructureFact.model_validate(
            {
                "uid": "fn-1",
                "type": "not_a_real_fact_type",  # FactType enum violation
                "claim": "c",
                "subject_uid": "obj-1",
                "predicate": "p",
                "object_value": "o",
                "negation_flag": False,
                "tags_suggested": [],
            },
        )
