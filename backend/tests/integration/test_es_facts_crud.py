"""Integration tests: Fact CRUD on the lucid_facts ES index."""
from __future__ import annotations

import pytest

from api.models.base import new_uid
from api.models.facts import FactNode

pytestmark = pytest.mark.integration


def _new_fact(claim: str = "EU AI Act took 36 months to pass", *, space: str | None = None) -> FactNode:
    return FactNode(
        fact_uid=new_uid(),
        claim=claim,
        type="proposition",
        subject_uid=new_uid(),
        predicate="took_to_pass",
        object_value="36_months",
        validation_method="manual",
        validator_id=new_uid(),
        knowledge_space_id=space or new_uid(),
    )


def test_create_fact_in_es(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts
    f = _new_fact()
    uid = facts.create_fact(f)
    assert uid == f.fact_uid
    stored = facts.get_fact_by_uid(uid)
    assert stored is not None
    assert stored["claim"] == f.claim


def test_create_fact_korean(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts
    f = _new_fact(claim="한국 AI 기본법은 2024년 12월 통과되었다")
    facts.create_fact(f)
    stored = facts.get_fact_by_uid(f.fact_uid)
    assert "한국 AI 기본법" in stored["claim"]


def test_create_fact_with_embedding_dim(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts
    f = _new_fact()
    facts.create_fact(f)
    stored = facts.get_fact_by_uid(f.fact_uid)
    # fake_embedding fixture produces a 1536-dim vector
    assert len(stored.get("embedding", [])) == 1536


def test_update_fact_alias_history(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts
    f = _new_fact()
    facts.create_fact(f)
    new_claim = "EU AI Act took 36 months to pass into law"
    editor = new_uid()
    facts.update_fact(f.fact_uid, {"claim": new_claim}, editor_uid=editor)
    stored = facts.get_fact_by_uid(f.fact_uid)
    assert stored["claim"] == new_claim
    assert f.claim in stored["aliases"]
    assert any(e["from_claim"] == f.claim for e in stored["edit_history"])


def test_delete_fact_cleans_object_fact_uids(es_indexes, fake_embedding):
    from api.models.objects import Concept
    from api.storage.elasticsearch import facts, objects
    space_id = new_uid()
    f = _new_fact(space=space_id)
    facts.create_fact(f)
    obj = Concept(
        object_uid=new_uid(),
        name="Test concept",
        knowledge_space_id=space_id,
        fact_uids=[f.fact_uid],
    )
    objects.create_object(obj)
    facts.delete_fact(f.fact_uid)
    stored = objects.get_object_by_uid(obj.object_uid)
    assert f.fact_uid not in (stored.get("fact_uids") or [])


def test_bulk_create_facts(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts
    space_id = new_uid()
    items = [_new_fact(claim=f"claim {i}", space=space_id) for i in range(5)]
    uids = facts.bulk_create_facts(items)
    assert len(uids) == 5
    for uid in uids:
        assert facts.get_fact_by_uid(uid) is not None
