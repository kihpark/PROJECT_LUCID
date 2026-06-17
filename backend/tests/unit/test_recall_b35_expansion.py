"""Unit tests for the B-25 stage-2 entity-link expansion (B-35 wiring).

The expansion runs AFTER the embedding kNN: every canonical entity uid
referenced by the initial result set (on subject_uid or as an entity-
shaped object_value) becomes a search key for a second ES query that
finds every other validated fact tied to the same entity. The PO's
reproduction target — "SpaceX 검색 -> SpaceX 가 subject 든 object 든
등장하는 fact 전부" — is exactly this join.
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from api.models.recall import RecallFact
from api.routes.recall import (
    _OBJ_PLACEHOLDER_RE,
    _UUID4_RE,
    _collect_entity_uids,
    _is_entity_ref,
)

SPACEX_UID = "550e8400-e29b-41d4-a716-446655440000"
GOLDMAN_UID = "550e8400-e29b-41d4-a716-446655440001"


def _fact(
    *,
    fact_uid: str,
    subject_uid: str,
    object_value: str,
    score: float = 0.9,
) -> RecallFact:
    return RecallFact(
        fact_uid=fact_uid,
        claim="x",
        subject_uid=subject_uid,
        predicate="p",
        object_value=object_value,
        source_uids=[],
        validated_at=datetime.now(UTC),
        validator_id="user-1",
        validation_method="manual",
        knowledge_space_id="ks-1",
        score=score,
    )


@pytest.mark.parametrize(
    "value",
    [
        SPACEX_UID,
        SPACEX_UID.upper(),
        "obj-1",
        "OBJ-12",
    ],
)
def test_is_entity_ref_accepts_canonical_and_placeholder(value):
    assert _is_entity_ref(value) is True


@pytest.mark.parametrize(
    "value",
    [
        "85.7 billion USD",
        "흑자",
        "2025-01-15",
        "",
        None,
        "spacex",            # plain word — no entity uid shape
        "obj-spacex",        # non-numeric suffix — not the placeholder shape
        "abc-def-ghi-jkl-mno",  # not hex
    ],
)
def test_is_entity_ref_rejects_literals_and_invalid(value):
    assert _is_entity_ref(value) is False


def test_uuid4_regex_uppercase_hex():
    assert _UUID4_RE.match("550E8400-E29B-41D4-A716-446655440000")


def test_obj_placeholder_regex_case_insensitive():
    assert _OBJ_PLACEHOLDER_RE.match("OBJ-99")


def test_collect_entity_uids_from_pure_subject_facts():
    """Every fact contributes its subject_uid as a candidate entity
    even if object_value is a literal."""
    facts = [
        _fact(fact_uid="fn-1", subject_uid=SPACEX_UID, object_value="85.7B USD"),
        _fact(fact_uid="fn-2", subject_uid=GOLDMAN_UID, object_value="50M shares"),
    ]
    uids = _collect_entity_uids(facts)
    assert set(uids) == {SPACEX_UID, GOLDMAN_UID}


def test_collect_entity_uids_picks_up_entity_object_value():
    """When object_value carries an entity ref it joins the candidate
    set — that's how SpaceX recall pulls in fn-3 (where SpaceX is the
    object) as well as fn-2 (where SpaceX is the subject)."""
    fn3 = _fact(
        fact_uid="fn-3",
        subject_uid=GOLDMAN_UID,        # Goldman Sachs subject
        object_value=SPACEX_UID,        # SpaceX as object
    )
    uids = _collect_entity_uids([fn3])
    assert set(uids) == {GOLDMAN_UID, SPACEX_UID}


def test_collect_entity_uids_skips_literal_object_value():
    """A fact whose object_value is a literal must NOT add the literal
    to the entity-uid set — the second ES pass must never run
    `terms` queries on free-text strings."""
    fn = _fact(
        fact_uid="fn-x",
        subject_uid=SPACEX_UID,
        object_value="85.7 billion USD",
    )
    uids = _collect_entity_uids([fn])
    assert uids == [SPACEX_UID]


def test_collect_entity_uids_dedupes_within_set():
    """Two facts that share the same subject_uid produce a single
    entry in the entity set — important so the second pass doesn't
    do extra redundant work."""
    facts = [
        _fact(fact_uid="fn-1", subject_uid=SPACEX_UID, object_value="a"),
        _fact(fact_uid="fn-2", subject_uid=SPACEX_UID, object_value="b"),
    ]
    uids = _collect_entity_uids(facts)
    assert uids == [SPACEX_UID]


def test_collect_entity_uids_preserves_first_appearance_order():
    """Determinism for caching / debugging: the order of returned uids
    matches the order of first appearance across the input facts."""
    fn1 = _fact(fact_uid="fn-1", subject_uid=GOLDMAN_UID, object_value=SPACEX_UID)
    fn2 = _fact(fact_uid="fn-2", subject_uid=SPACEX_UID, object_value="literal")
    uids = _collect_entity_uids([fn1, fn2])
    assert uids == [GOLDMAN_UID, SPACEX_UID]


def test_collect_entity_uids_empty_input_returns_empty():
    assert _collect_entity_uids([]) == []
