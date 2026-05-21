"""Integration tests: kNN + nori text + faceted search."""
from __future__ import annotations

import pytest

from api.models.base import new_uid
from api.models.facts import FactNode

pytestmark = pytest.mark.integration


def _make_fact(claim: str, tags: list[str], type_: str, space: str) -> FactNode:
    return FactNode(
        fact_uid=new_uid(),
        claim=claim,
        type=type_,
        subject_uid=new_uid(),
        predicate="p",
        object_value="o",
        validation_method="manual",
        validator_id=new_uid(),
        tags=tags,
        knowledge_space_id=space,
    )


def test_text_search_korean(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts, queries
    space = new_uid()
    facts.create_fact(_make_fact("지식 그래프 검증 시스템", ["ai"], "proposition", space))
    facts.create_fact(_make_fact("그래프 데이터베이스 비교", ["db"], "proposition", space))
    out = queries.text_search_facts("지식", lang="ko", knowledge_space_id=space)
    claims = [h["claim"] for h in out]
    assert any("지식 그래프" in c for c in claims)


def test_text_search_english(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts, queries
    space = new_uid()
    facts.create_fact(
        FactNode(
            fact_uid=new_uid(),
            claim="EU AI Act enforcement begins August 2024",
            claim_en="EU AI Act enforcement begins August 2024",
            type="proposition",
            subject_uid=new_uid(),
            predicate="p",
            object_value="o",
            validation_method="manual",
            validator_id=new_uid(),
            knowledge_space_id=space,
        )
    )
    out = queries.text_search_facts(
        "AI Act", lang="en", knowledge_space_id=space
    )
    assert any("AI Act" in h.get("claim_en", "") for h in out)


def test_knn_search_returns_top_k(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts, queries
    space = new_uid()
    for i in range(7):
        facts.create_fact(_make_fact(f"claim {i}", ["ai"], "proposition", space))
    out = queries.knn_search_facts(
        embedding=list(fake_embedding),
        k=3,
        knowledge_space_id=space,
    )
    assert len(out) == 3


def test_faceted_search_class_tag_source(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts, queries
    space = new_uid()
    facts.create_fact(_make_fact("A", ["ai"], "proposition", space))
    facts.create_fact(_make_fact("B", ["ai", "law"], "proposition", space))
    facts.create_fact(_make_fact("C", ["law"], "procedure", space))
    out = queries.faceted_search_facts(knowledge_space_id=space)
    assert out["total"] == 3
    assert "type" in out["facets"]
    assert "tags" in out["facets"]
    type_counts = {b["value"]: b["count"] for b in out["facets"]["type"]}
    assert type_counts.get("proposition") == 2
    assert type_counts.get("procedure") == 1


def test_query_excludes_other_spaces(es_indexes, fake_embedding):
    """Same claim in two spaces — query for one space sees only its own."""
    from api.storage.elasticsearch import facts, queries
    space_a = new_uid()
    space_b = new_uid()
    facts.create_fact(_make_fact("shared claim", ["t"], "proposition", space_a))
    facts.create_fact(_make_fact("shared claim", ["t"], "proposition", space_b))
    out = queries.text_search_facts(
        "shared", lang="ko", knowledge_space_id=space_a
    )
    space_ids = {h["knowledge_space_id"] for h in out}
    assert space_ids == {space_a}
