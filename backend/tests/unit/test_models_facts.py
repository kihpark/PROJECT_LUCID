"""Unit tests for backend/api/models/facts.py.

Includes the three negative tests that enforce DR-053 / CONFLICTS.md C-14:
no valid_until, no is_stale, no stale_at — anywhere — ever.
"""
from __future__ import annotations

from datetime import UTC, datetime, timezone

import pytest
from pydantic import ValidationError

from api.models.base import new_uid
from api.models.facts import AtomicFact, EditRecord, FactNode, FactType


def test_atomic_fact_creation_minimal():
    af = AtomicFact(
        claim="EU AI Act took 36 months to pass",
        type="proposition",
        subject_uid=new_uid(),
        predicate="took_to_pass",
        object_value="36_months",
    )
    assert af.type_ is FactType.PROPOSITION
    assert af.valid_from is None
    assert af.tags_suggested == []


def test_atomic_fact_valid_from_optional_is_context_only():
    """valid_from is allowed as context metadata; it does not trigger expiry."""
    when = datetime(2024, 8, 1, tzinfo=UTC)
    af = AtomicFact(
        claim="X",
        type="proposition",
        subject_uid=new_uid(),
        predicate="p",
        object_value="o",
        valid_from=when,
    )
    assert af.valid_from == when


# --- CRITICAL: 3 STALE NEGATIVE TESTS (DR-053 / CONFLICTS.md C-14) ---

@pytest.mark.parametrize("model_cls,extra_kwargs", [
    (AtomicFact, {
        "claim": "X",
        "type": "proposition",
        "subject_uid": "u1",
        "predicate": "p",
        "object_value": "o",
    }),
    (FactNode, {
        "fact_uid": "f1",
        "claim": "X",
        "type": "proposition",
        "subject_uid": "u1",
        "predicate": "p",
        "object_value": "o",
        "validation_method": "manual",
        "validator_id": "v1",
        "knowledge_space_id": "k1",
    }),
])
def test_facts_reject_valid_until(model_cls, extra_kwargs):
    """valid_until is retired in v2; setting it must raise ValidationError."""
    with pytest.raises(ValidationError):
        model_cls(valid_until=datetime.now(UTC), **extra_kwargs)


@pytest.mark.parametrize("model_cls,extra_kwargs", [
    (AtomicFact, {
        "claim": "X",
        "type": "proposition",
        "subject_uid": "u1",
        "predicate": "p",
        "object_value": "o",
    }),
    (FactNode, {
        "fact_uid": "f1",
        "claim": "X",
        "type": "proposition",
        "subject_uid": "u1",
        "predicate": "p",
        "object_value": "o",
        "validation_method": "manual",
        "validator_id": "v1",
        "knowledge_space_id": "k1",
    }),
])
def test_facts_reject_is_stale(model_cls, extra_kwargs):
    """is_stale is retired in v2; setting it must raise ValidationError."""
    with pytest.raises(ValidationError):
        model_cls(is_stale=False, **extra_kwargs)


@pytest.mark.parametrize("model_cls,extra_kwargs", [
    (AtomicFact, {
        "claim": "X",
        "type": "proposition",
        "subject_uid": "u1",
        "predicate": "p",
        "object_value": "o",
    }),
    (FactNode, {
        "fact_uid": "f1",
        "claim": "X",
        "type": "proposition",
        "subject_uid": "u1",
        "predicate": "p",
        "object_value": "o",
        "validation_method": "manual",
        "validator_id": "v1",
        "knowledge_space_id": "k1",
    }),
])
def test_facts_reject_stale_at(model_cls, extra_kwargs):
    """stale_at is retired in v2; setting it must raise ValidationError."""
    with pytest.raises(ValidationError):
        model_cls(stale_at=datetime.now(UTC), **extra_kwargs)


# --- Fact lifecycle / Edit history ---

def test_fact_node_creation_full():
    fn = FactNode(
        fact_uid=new_uid(),
        claim="EU AI Act enforcement begins August 2024",
        claim_en=None,
        type="proposition",
        subject_uid=new_uid(),
        predicate="enforcement_begins",
        object_value="2024-08",
        validation_method="manual",
        validator_id=new_uid(),
        source_uids=[new_uid()],
        tags=["legal", "EU"],
        knowledge_space_id=new_uid(),
    )
    assert fn.override_warning is False
    assert fn.aliases == []
    assert fn.edit_history == []


def test_edit_record_appendable():
    er = EditRecord(
        from_claim="EU AI Act took 36 months",
        to_claim="EU AI Act took 36 months to pass into law",
        edited_by=new_uid(),
    )
    assert er.from_claim != er.to_claim
    assert er.edited_at.tzinfo is not None
