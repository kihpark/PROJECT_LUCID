"""Unit: DCR-001 negation + NEGATES + disambiguation models."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.models.base import new_uid
from api.models.disambiguation import (
    DecisionMethod,
    DisambiguationCandidate,
    DisambiguationCard,
    DisambiguationLog,
)
from api.models.facts import AtomicFact, FactNode
from api.models.links import FactFactLinkType

# --- A. Negation fields on AtomicFact / FactNode ----------------------

def _atomic_kwargs() -> dict:
    return {
        "claim": "EU AI Act does NOT apply to military",
        "type": "proposition",
        "subject_uid": new_uid(),
        "predicate": "applies_to",
        "object_value": "military",
    }


def _fact_node_kwargs() -> dict:
    return {
        "fact_uid": new_uid(),
        "claim": "X",
        "type": "proposition",
        "subject_uid": new_uid(),
        "predicate": "p",
        "object_value": "o",
        "validation_method": "manual",
        "validator_id": new_uid(),
        "knowledge_space_id": new_uid(),
    }


def test_atomic_fact_negation_flag_default_false():
    af = AtomicFact(**_atomic_kwargs())
    assert af.negation_flag is False
    assert af.negation_scope is None


def test_atomic_fact_with_negation_full():
    af = AtomicFact(**_atomic_kwargs(), negation_flag=True, negation_scope="full")
    assert af.negation_flag is True
    assert af.negation_scope == "full"


def test_atomic_fact_with_negation_partial():
    af = AtomicFact(**_atomic_kwargs(), negation_flag=True, negation_scope="partial")
    assert af.negation_scope == "partial"


def test_atomic_fact_negation_scope_literal_rejects_unknown():
    with pytest.raises(ValidationError):
        AtomicFact(**_atomic_kwargs(), negation_flag=True, negation_scope="kinda")


def test_fact_node_negation_fields_round_trip():
    fn = FactNode(**_fact_node_kwargs(), negation_flag=True, negation_scope="full")
    assert fn.negation_flag is True
    assert fn.negation_scope == "full"


# --- B. NEGATES link type --------------------------------------------

def test_fact_fact_link_type_has_seven_members_including_negates():
    """DCR-001 added NEGATES; Fact <-> Fact enum is now 7."""
    assert len(FactFactLinkType) == 7
    assert FactFactLinkType.NEGATES.value == "negates"
    expected = {
        "supports",
        "contradicts",
        "example_of",
        "derived_from",
        "interprets",
        "supersedes",
        "negates",
    }
    assert {m.value for m in FactFactLinkType} == expected


# --- C. Disambiguation Pydantic shapes -------------------------------

def test_disambiguation_candidate_score_range():
    c = DisambiguationCandidate(object_uid=new_uid(), score=0.91, summary="Apple Inc.")
    assert 0.0 <= c.score <= 1.0


def test_disambiguation_candidate_rejects_out_of_range_score():
    with pytest.raises(ValidationError):
        DisambiguationCandidate(object_uid=new_uid(), score=1.5)
    with pytest.raises(ValidationError):
        DisambiguationCandidate(object_uid=new_uid(), score=-0.1)


def test_disambiguation_card_with_candidates():
    card = DisambiguationCard(
        fact_uid=new_uid(),
        original_mention="Apple",
        context="Apple is launching a new...",
        candidates=[
            DisambiguationCandidate(object_uid=new_uid(), score=0.91),
            DisambiguationCandidate(object_uid=new_uid(), score=0.88),
        ],
    )
    assert len(card.candidates) == 2
    assert card.original_mention == "Apple"


def test_disambiguation_log_existing_decision():
    log = DisambiguationLog(
        fact_uid=new_uid(),
        mention_text="Apple",
        resolved_to_uid=new_uid(),
        decision_method="existing",
        decided_by=new_uid(),
    )
    assert log.decision_method == "existing"
    assert log.resolved_to_uid is not None


def test_disambiguation_log_new_decision_allows_null_resolved_uid():
    log = DisambiguationLog(
        fact_uid=new_uid(),
        mention_text="Apple",
        resolved_to_uid=None,
        decision_method="new",
        decided_by=new_uid(),
    )
    assert log.resolved_to_uid is None
    assert log.decision_method == "new"


def test_disambiguation_log_rejects_unknown_decision_method():
    with pytest.raises(ValidationError):
        DisambiguationLog(
            fact_uid=new_uid(),
            mention_text="Apple",
            resolved_to_uid=None,
            decision_method="maybe",
            decided_by=new_uid(),
        )


# --- D. ES mapping update sanity --------------------------------------

def test_es_lucid_facts_mapping_has_negation_fields():
    from api.storage.elasticsearch.mappings import LUCID_FACTS_MAPPING

    props = LUCID_FACTS_MAPPING["mappings"]["properties"]
    assert props["negation_flag"]["type"] == "boolean"
    assert props["negation_scope"]["type"] == "keyword"
