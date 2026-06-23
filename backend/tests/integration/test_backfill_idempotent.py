"""Integration tests for entity_reclassifier.run_backfill().

Verifies the idempotency contract: running the backfill once promotes
concept-stuck legacy entities to typed classes; running it again is a
zero-update no-op. Also verifies that already-typed entities are
never overwritten.

LLM is monkey-patched to a deterministic local fallback so these tests
don't depend on a live Anthropic key.
"""
from __future__ import annotations

import uuid

import pytest

from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
from api.structure import entity_reclassifier
from api.structure.entity_reclassifier import run_backfill

pytestmark = pytest.mark.integration


def _seed_object(
    es_client,
    *,
    ks_id: str,
    name: str,
    class_: str = "concept",
    entity_type: str | None = None,
    aliases: list[str] | None = None,
) -> str:
    """Insert a lucid_objects doc directly so we control its initial
    class/entity_type/name without going through the resolver."""
    object_uid = f"obj-{uuid.uuid4().hex[:10]}"
    doc = {
        "object_uid": object_uid,
        "class": class_,
        "entity_type": entity_type,
        "name": name,
        "primary_label": name,
        "primary_lang": "ko",
        "aliases": list(aliases or []),
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": ks_id,
    }
    es_client.index(
        index=LUCID_OBJECTS, id=object_uid, document=doc, refresh="wait_for",
    )
    return object_uid


def _delete_object(es_client, doc_id: str) -> None:
    try:
        es_client.delete(
            index=LUCID_OBJECTS, id=doc_id, refresh="wait_for",
        )
    except Exception:
        pass


def _get_class(es_client, doc_id: str) -> tuple[str, str | None]:
    src = es_client.get(index=LUCID_OBJECTS, id=doc_id)["_source"]
    return (src.get("class") or "", src.get("entity_type"))


@pytest.fixture
def fresh_ks(es_indexes):
    """A clean ks_id scoped to this test. The es_indexes fixture
    rebuilt the indexes session-scoped; we just need a unique id.

    Defensively re-ensure the indexes exist — other test files in
    the same session (test_ensure_mappings.py especially) delete and
    recreate the indexes mid-session, and their teardown ordering can
    leave us without `lucid_objects` when our tests run.
    """
    from api.storage.elasticsearch import indexes
    indexes.create_indexes()
    return f"ks-backfill-{uuid.uuid4().hex[:10]}"


def test_run_backfill_promotes_concept_stuck_entities(
    monkeypatch, es_client, fresh_ks,
):
    """Three concept-stuck entities with names the heuristic recognizes
    => all three get promoted on a single pass."""
    # Disable LLM to keep the test offline; the names are all
    # heuristic-recognizable.
    monkeypatch.setattr(
        entity_reclassifier,
        "classify_by_llm",
        lambda name, context=None: "other",
    )

    ids = []
    try:
        ids.append(_seed_object(
            es_client, ks_id=fresh_ks, name="정청래",
        ))  # person
        ids.append(_seed_object(
            es_client, ks_id=fresh_ks, name="더불어민주당",
        ))  # organization
        ids.append(_seed_object(
            es_client, ks_id=fresh_ks, name="미국",
        ))  # place

        client = get_client()
        result = run_backfill(client, fresh_ks, use_llm=False, apply=True)

        assert result["scanned"] == 3
        assert result["updated"] == 3
        assert result["by_class"].get("person") == 1
        assert result["by_class"].get("organization") == 1
        assert result["by_class"].get("place") == 1

        # Verify the writes landed on BOTH class and entity_type.
        es_client.indices.refresh(index=LUCID_OBJECTS)
        c1, t1 = _get_class(es_client, ids[0])
        assert c1 == "person" and t1 == "person"
        c2, t2 = _get_class(es_client, ids[1])
        assert c2 == "organization" and t2 == "organization"
        c3, t3 = _get_class(es_client, ids[2])
        assert c3 == "place" and t3 == "place"
    finally:
        for d in ids:
            _delete_object(es_client, d)


def test_run_backfill_is_idempotent(
    monkeypatch, es_client, fresh_ks,
):
    """First pass promotes; second pass is a no-op."""
    monkeypatch.setattr(
        entity_reclassifier,
        "classify_by_llm",
        lambda name, context=None: "other",
    )

    ids = []
    try:
        ids.append(_seed_object(es_client, ks_id=fresh_ks, name="정청래"))
        ids.append(_seed_object(es_client, ks_id=fresh_ks, name="더불어민주당"))

        client = get_client()
        first = run_backfill(client, fresh_ks, use_llm=False, apply=True)
        assert first["updated"] == 2

        es_client.indices.refresh(index=LUCID_OBJECTS)

        second = run_backfill(client, fresh_ks, use_llm=False, apply=True)
        assert second["scanned"] == 2
        assert second["updated"] == 0, (
            "second pass must be a no-op (idempotency contract)"
        )
        assert second["skipped"] == 2
    finally:
        for d in ids:
            _delete_object(es_client, d)


def test_run_backfill_does_not_overwrite_typed_entities(
    monkeypatch, es_client, fresh_ks,
):
    """A mix of (1 concept + 1 already-typed person) — only the concept
    one is touched. The already-typed entity is never overwritten even
    if the heuristic would disagree."""
    monkeypatch.setattr(
        entity_reclassifier,
        "classify_by_llm",
        lambda name, context=None: "other",
    )

    ids = []
    try:
        # Already-typed person — must NOT be touched even though the
        # heuristic would still say 'person' (idempotency by design).
        ids.append(_seed_object(
            es_client, ks_id=fresh_ks, name="정청래",
            class_="person", entity_type="person",
        ))
        # Concept-stuck org — SHOULD be promoted.
        ids.append(_seed_object(
            es_client, ks_id=fresh_ks, name="더불어민주당",
        ))

        client = get_client()
        result = run_backfill(client, fresh_ks, use_llm=False, apply=True)

        assert result["scanned"] == 2
        assert result["updated"] == 1
        assert result["skipped"] == 1
        assert result["by_class"].get("organization") == 1

        es_client.indices.refresh(index=LUCID_OBJECTS)
        c_person, _ = _get_class(es_client, ids[0])
        assert c_person == "person"  # unchanged
        c_org, _ = _get_class(es_client, ids[1])
        assert c_org == "organization"  # promoted
    finally:
        for d in ids:
            _delete_object(es_client, d)


def test_run_backfill_dry_run_does_not_write(
    monkeypatch, es_client, fresh_ks,
):
    """apply=False reports the would-be changes but never calls update()."""
    monkeypatch.setattr(
        entity_reclassifier,
        "classify_by_llm",
        lambda name, context=None: "other",
    )

    ids = []
    try:
        ids.append(_seed_object(es_client, ks_id=fresh_ks, name="정청래"))

        client = get_client()
        result = run_backfill(client, fresh_ks, use_llm=False, apply=False)

        assert result["scanned"] == 1
        assert result["updated"] == 1
        assert result["applied"] is False

        # Verify nothing was actually written.
        es_client.indices.refresh(index=LUCID_OBJECTS)
        c, _ = _get_class(es_client, ids[0])
        assert c == "concept", "dry-run must not write"
    finally:
        for d in ids:
            _delete_object(es_client, d)
