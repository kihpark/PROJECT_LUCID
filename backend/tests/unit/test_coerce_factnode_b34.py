"""Unit tests for B-34 structured-edit metadata application.

When the user edits a fact via the S/P/O editor, the frontend sends
`edited_metadata = {subject_uid, predicate, object_value}`. The
backend's `_coerce_fact_to_factnode` already merges this dict over
the original fact_summary, so any populated field overrides; the
others fall back. These tests pin that contract.
"""
from __future__ import annotations

import pytest

from api.routes.validate import _coerce_fact_to_factnode


@pytest.fixture
def base_fact() -> dict:
    return {
        "fact_uid": "fn-1",
        "uid": "fn-1",
        "claim": "Goldman Sachs는 SpaceX IPO의 주관사다.",
        "type": "proposition",
        "subject_uid": "obj-2",
        "predicate": "is_underwriter_for",
        "object_value": "SpaceX IPO",
        "negation_flag": False,
        "negation_scope": None,
    }


def test_no_edits_falls_back_to_original(base_fact):
    node = _coerce_fact_to_factnode(
        base_fact, edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.subject_uid == "obj-2"
    assert node.predicate == "is_underwriter_for"
    assert node.object_value == "SpaceX IPO"
    assert node.claim == "Goldman Sachs는 SpaceX IPO의 주관사다."


def test_edited_subject_uid_overrides(base_fact):
    node = _coerce_fact_to_factnode(
        base_fact,
        edited_claim="Morgan Stanley | is_underwriter_for | SpaceX IPO",
        edited_metadata={"subject_uid": "obj-3"},
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.subject_uid == "obj-3"
    # Untouched fields fall back to the original.
    assert node.predicate == "is_underwriter_for"
    assert node.object_value == "SpaceX IPO"
    assert node.claim == "Morgan Stanley | is_underwriter_for | SpaceX IPO"


def test_edited_predicate_overrides(base_fact):
    node = _coerce_fact_to_factnode(
        base_fact,
        edited_claim="Goldman Sachs | sponsored | SpaceX IPO",
        edited_metadata={"predicate": "sponsored"},
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.predicate == "sponsored"
    assert node.subject_uid == "obj-2"
    assert node.object_value == "SpaceX IPO"


def test_edited_object_value_overrides_with_obj_ref(base_fact):
    """When the frontend auto-resolves a typed entity name to an
    obj-N uid, the stored object_value should carry that ref."""
    node = _coerce_fact_to_factnode(
        base_fact,
        edited_claim="Goldman Sachs | is_underwriter_for | Tesla IPO",
        edited_metadata={"object_value": "obj-9"},
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.object_value == "obj-9"


def test_all_three_fields_edited_together(base_fact):
    node = _coerce_fact_to_factnode(
        base_fact,
        edited_claim="Morgan Stanley | sponsored | obj-9",
        edited_metadata={
            "subject_uid": "obj-3",
            "predicate": "sponsored",
            "object_value": "obj-9",
        },
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.subject_uid == "obj-3"
    assert node.predicate == "sponsored"
    assert node.object_value == "obj-9"


def test_edited_metadata_preserves_negation_flag(base_fact):
    """A structured edit must not silently clear the negation flag —
    the metadata override is additive over the original fact dict."""
    base_fact["negation_flag"] = True
    base_fact["negation_scope"] = "full"
    node = _coerce_fact_to_factnode(
        base_fact,
        edited_claim="x | y | z",
        edited_metadata={"predicate": "is_not_underwriter_for"},
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.negation_flag is True
    assert node.negation_scope == "full"
