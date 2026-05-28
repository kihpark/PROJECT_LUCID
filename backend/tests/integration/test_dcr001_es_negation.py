"""Integration: ES lucid_facts negation_flag filter (DCR-001)."""
from __future__ import annotations

import pytest

from api.models.base import new_uid
from api.models.facts import FactNode

pytestmark = pytest.mark.integration


def _fact(claim: str, *, negation_flag: bool, scope: str | None, space: str) -> FactNode:
    return FactNode(
        fact_uid=new_uid(),
        claim=claim,
        type="proposition",
        subject_uid=new_uid(),
        predicate="p",
        object_value="o",
        validation_method="manual",
        validator_id=new_uid(),
        knowledge_space_id=space,
        negation_flag=negation_flag,
        negation_scope=scope,
    )


def test_negation_flag_persists_in_es(es_indexes, fake_embedding):
    from api.storage.elasticsearch import facts
    space = new_uid()
    fn = _fact("EU AI Act does NOT apply to military", negation_flag=True, scope="full", space=space)
    facts.create_fact(fn)
    stored = facts.get_fact_by_uid(fn.fact_uid)
    assert stored["negation_flag"] is True
    assert stored["negation_scope"] == "full"


def test_es_filter_by_negation_flag(es_indexes, fake_embedding):
    """text_search_facts + extra_filters={negation_flag: True} returns only negations."""
    from api.storage.elasticsearch import facts, queries

    space = new_uid()
    facts.create_fact(_fact("affirmative one", negation_flag=False, scope=None, space=space))
    facts.create_fact(_fact("affirmative two", negation_flag=False, scope=None, space=space))
    facts.create_fact(_fact("NEGATIVE one", negation_flag=True, scope="full", space=space))

    out = queries.text_search_facts(
        "one",
        lang="ko",
        knowledge_space_id=space,
        extra_filters={"negation_flag": True},
    )
    # Only the one negative fact comes back
    assert len(out) == 1
    assert out[0]["negation_flag"] is True
