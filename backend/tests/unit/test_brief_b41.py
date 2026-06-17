"""Unit tests for B-41 P1 brief synthesis at the route level.

We exercise `_build_entity_brief` directly with stubbed ES helpers
so the assertion surface stays at the synthesis logic (group-by-
predicate + role split + label resolution). No live ES needed.
"""
from __future__ import annotations

from unittest.mock import patch


def _fact_hit(
    *,
    fact_uid: str,
    subject_uid: str,
    predicate: str,
    object_value: str,
    claim: str = "x",
    knowledge_space_id: str = "ks-1",
) -> dict:
    return {
        "_id": fact_uid,
        "_source": {
            "fact_uid": fact_uid,
            "claim": claim,
            "predicate": predicate,
            "subject_uid": subject_uid,
            "object_value": object_value,
            "validation_method": "manual",
            "knowledge_space_id": knowledge_space_id,
        },
    }


def test_build_brief_returns_none_when_entity_not_found():
    from api.routes.recall import _build_entity_brief

    with patch(
        "api.routes.recall._resolve_entity_by_name", return_value=None,
    ):
        out = _build_entity_brief("unknown name", "ks-1")
    assert out is None


def test_build_brief_groups_facts_by_predicate_with_role_split():
    from api.routes.recall import _build_entity_brief

    entity_uid = "11111111-2222-3333-4444-555555555555"
    goldman_uid = "6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f"

    entity_doc = {
        "object_uid": entity_uid,
        "name": "SpaceX",
        "class": "organization",
    }
    hits = [
        # SpaceX is the subject on two different predicates.
        _fact_hit(
            fact_uid="fn-1", subject_uid=entity_uid,
            predicate="total_funds_raised",
            object_value="85.7 billion USD",
            claim="SpaceX raised 85.7B USD",
        ),
        _fact_hit(
            fact_uid="fn-2", subject_uid=entity_uid,
            predicate="set_ipo_price",
            object_value="135 USD per share",
            claim="SpaceX set IPO price at 135",
        ),
        # SpaceX is the object on one fact.
        _fact_hit(
            fact_uid="fn-3", subject_uid=goldman_uid,
            predicate="is_underwriter_for",
            object_value=entity_uid,
            claim="Goldman Sachs is underwriter for SpaceX IPO",
        ),
    ]
    mget_docs = {
        "docs": [
            {"_id": goldman_uid, "found": True,
             "_source": {"object_uid": goldman_uid, "name": "Goldman Sachs"}},
        ],
    }

    class _FakeClient:
        def mget(self, **kwargs):
            return mget_docs

    with patch(
        "api.routes.recall._resolve_entity_by_name", return_value=entity_doc,
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=hits,
    ), patch("api.routes.recall.get_client", return_value=_FakeClient()):
        brief = _build_entity_brief("SpaceX", "ks-1")

    assert brief is not None
    assert brief.entity_uid == entity_uid
    assert brief.entity_name == "SpaceX"
    assert brief.entity_class == "organization"
    assert brief.total_facts == 3

    subject_predicates = sorted(g.predicate for g in brief.as_subject)
    assert subject_predicates == ["set_ipo_price", "total_funds_raised"]

    object_predicates = [g.predicate for g in brief.as_object]
    assert object_predicates == ["is_underwriter_for"]

    # The Goldman Sachs label was resolved via the mget.
    object_fact = brief.as_object[0].facts[0]
    assert object_fact.fact_uid == "fn-3"
    assert object_fact.other_uid == goldman_uid
    assert object_fact.other_label == "Goldman Sachs"

    # The literal object_value side did NOT get a label (not an entity ref).
    literal_fact = next(
        g for g in brief.as_subject if g.predicate == "total_funds_raised"
    ).facts[0]
    assert literal_fact.other_uid == "85.7 billion USD"
    assert literal_fact.other_label is None


def test_build_brief_zero_facts_still_returns_envelope():
    """An entity exists in lucid_objects but no manual facts reference
    it yet. The brief returns an empty envelope so the UI can render
    "검증된 사실이 없습니다" inside the panel."""
    from api.routes.recall import _build_entity_brief

    entity_doc = {
        "object_uid": "e-1",
        "name": "Quiet Entity",
        "class": "concept",
    }
    with patch(
        "api.routes.recall._resolve_entity_by_name", return_value=entity_doc,
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=[],
    ):
        brief = _build_entity_brief("Quiet Entity", "ks-1")

    assert brief is not None
    assert brief.total_facts == 0
    assert brief.as_subject == []
    assert brief.as_object == []


def test_build_brief_drops_facts_unrelated_to_entity_uid():
    """Defensive: even if the helper somehow surfaced a fact whose
    subject and object both differ from entity_uid (shouldn't happen
    given the route query, but the synthesis must never silently
    bucket a stranger fact). The fact gets ignored."""
    from api.routes.recall import _build_entity_brief

    entity_uid = "e-1"
    entity_doc = {"object_uid": entity_uid, "name": "E", "class": "concept"}
    stranger_hit = _fact_hit(
        fact_uid="fn-x", subject_uid="other", predicate="p",
        object_value="not-related",
    )

    with patch(
        "api.routes.recall._resolve_entity_by_name", return_value=entity_doc,
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=[stranger_hit],
    ):
        brief = _build_entity_brief("E", "ks-1")

    assert brief is not None
    assert brief.total_facts == 0
    assert brief.as_subject == []
    assert brief.as_object == []
