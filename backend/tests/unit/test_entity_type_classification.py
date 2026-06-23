"""feat/entity-layer-restore — entity_type classification unit tests.

PO directive (2026-06-23): every entity in lucid_objects must carry the
LLM-classified ObjectClass on BOTH the legacy `class` field and the
canonical `entity_type` field. The break point identified in discovery
was `entity_resolver._create_entity` hardcoding "concept" regardless of
what the LLM emitted. These tests pin the contract.

What's covered (mock — no live LLM, no live ES):

  1. _create_entity writes BOTH class and entity_type when given
     entity_class
  2. _create_entity falls back to "concept" only when entity_class is
     None (backward compat)
  3. resolve_entity threads entity_class through to _create_entity on
     the create-new branch
  4. _maybe_backfill_class promotes a legacy concept doc to the LLM
     class on a lookup hit
  5. _maybe_backfill_class is idempotent when both fields already match
  6. _maybe_backfill_class does NOT downgrade an existing non-concept
     class to a conflicting one
"""
from __future__ import annotations

from unittest.mock import MagicMock

from api.structure.entity_resolver import (
    _create_entity,
    _maybe_backfill_class,
    resolve_entity,
)


def test_create_entity_writes_class_and_entity_type_when_given() -> None:
    """The most basic write-path contract — entity_class lands on both
    fields. This was the regression: previously every doc got
    'concept' regardless of input.
    """
    client = MagicMock()
    uid = _create_entity(
        client,
        surface="한동훈",
        lang="ko",
        knowledge_space_id="ks-1",
        entity_class="person",
    )
    assert uid  # uid is fresh
    args, kwargs = client.index.call_args
    body = kwargs["document"]
    assert body["class"] == "person"
    assert body["entity_type"] == "person"
    assert body["name"] == "한동훈"
    assert body["primary_label"] == "한동훈"


def test_create_entity_falls_back_to_concept_when_class_missing() -> None:
    """Backward-compat — callers that don't supply entity_class (legacy
    tests, migrations) still get the prior 'concept' default. Otherwise
    we'd break a fleet of unit tests written against the pre-restore
    behavior.
    """
    client = MagicMock()
    _create_entity(
        client,
        surface="추상 개념",
        lang="ko",
        knowledge_space_id="ks-1",
    )
    body = client.index.call_args.kwargs["document"]
    assert body["class"] == "concept"
    assert body["entity_type"] == "concept"


def test_resolve_entity_threads_class_to_create_path(monkeypatch) -> None:
    """End-to-end on the create-new branch (no lookup hit): the kwarg
    flows from resolve_entity → _create_entity. This is the surface
    path the processor uses in production.
    """
    fake_client = MagicMock()
    # Empty lookups so we end up on the create-new branch.
    fake_client.search.return_value = {"hits": {"hits": []}}
    fake_client.update.return_value = None

    uid, was_created = resolve_entity(
        "삼성전자",
        "ko",
        space_id="ks-1",
        llm_name="삼성전자",
        es_client=fake_client,
        entity_class="organization",
    )
    assert was_created
    assert uid
    # _create_entity calls client.index — the body has both fields set.
    args, kwargs = fake_client.index.call_args
    body = kwargs["document"]
    assert body["class"] == "organization"
    assert body["entity_type"] == "organization"


def test_maybe_backfill_class_promotes_legacy_concept_to_llm_class() -> None:
    """The most important migration path — every existing 한동훈 in the
    live system is class='concept', entity_type missing. On the next
    capture the LLM says 'person'; we must promote.
    """
    client = MagicMock()
    existing = {
        "object_uid": "uid-1",
        "class": "concept",  # legacy default
        "name": "한동훈",
        "primary_label": "한동훈",
    }
    _maybe_backfill_class(
        client=client,
        object_uid="uid-1",
        existing=existing,
        entity_class="person",
    )
    args, kwargs = client.update.call_args
    assert kwargs["id"] == "uid-1"
    doc = kwargs["doc"]
    assert doc["class"] == "person"
    assert doc["entity_type"] == "person"


def test_maybe_backfill_class_is_idempotent_when_fields_match() -> None:
    """When both class and entity_type already equal the LLM's call,
    do nothing. Avoids ES write storms on every capture re-touch.
    """
    client = MagicMock()
    existing = {
        "object_uid": "uid-1",
        "class": "person",
        "entity_type": "person",
        "name": "한동훈",
    }
    _maybe_backfill_class(
        client=client,
        object_uid="uid-1",
        existing=existing,
        entity_class="person",
    )
    client.update.assert_not_called()


def test_maybe_backfill_class_does_not_downgrade_existing_real_class() -> None:
    """If the existing doc has a real non-concept class that DISAGREES
    with the LLM (LLM classifier disagreement), keep the existing
    value. We refuse to silently rewrite history when both sides are
    making real claims.
    """
    client = MagicMock()
    existing = {
        "object_uid": "uid-1",
        "class": "organization",
        "entity_type": "organization",
        "name": "Some Ambiguous Thing",
    }
    _maybe_backfill_class(
        client=client,
        object_uid="uid-1",
        existing=existing,
        entity_class="person",  # LLM disagrees
    )
    client.update.assert_not_called()


def test_maybe_backfill_class_noop_when_llm_class_is_concept() -> None:
    """When the LLM falls back to 'concept' (the catch-all bucket),
    do not overwrite an existing real class. Concept is information-
    less; it would always lose to whatever already exists.
    """
    client = MagicMock()
    existing = {
        "object_uid": "uid-1",
        "class": "person",
        "entity_type": "person",
        "name": "한동훈",
    }
    _maybe_backfill_class(
        client=client,
        object_uid="uid-1",
        existing=existing,
        entity_class="concept",
    )
    client.update.assert_not_called()


def test_maybe_backfill_class_noop_when_llm_class_is_none() -> None:
    """No information from the LLM → no write."""
    client = MagicMock()
    existing = {"object_uid": "uid-1", "class": "concept", "name": "x"}
    _maybe_backfill_class(
        client=client,
        object_uid="uid-1",
        existing=existing,
        entity_class=None,
    )
    client.update.assert_not_called()
