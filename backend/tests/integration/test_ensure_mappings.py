"""Integration: ensure_mappings non-destructive field-level sync.

feat/mappings-sync-permanent (2026-06-23): codifies the runtime
`put_mapping` we ran against PO's dev ES when the entity-layer
fields drifted behind the writer code. These tests pin the contract:

- All fields already present  -> empty added list per index
- One field missing on a live index -> put_mapping fires, field appears
- Index doesn't exist on the cluster -> skipped (absent from result)
- put_mapping raises -> caught, logged, returns empty list (graceful)
"""
from __future__ import annotations

import types

import pytest

pytestmark = pytest.mark.integration


def test_all_fields_present_returns_empty_added(es_indexes):
    """Happy path: a freshly recreated index already matches the
    declared mapping -> ensure_mappings returns [] per index.

    Self-contained: explicitly recreate the three indexes from this
    worktree's mappings.py rather than relying on the session fixture's
    state — under concurrent agent runs another session can reset the
    shared `test_*` indexes from an older mappings.py, which would
    leave drift behind even on a freshly fixture-created index.
    """
    from api.storage.elasticsearch import indexes
    from api.storage.elasticsearch.client import (
        LUCID_FACTS,
        LUCID_OBJECTS,
        LUCID_SOURCES,
    )

    indexes.delete_indexes(names=[LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES])
    indexes.create_indexes(names=[LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES])

    result = indexes.ensure_mappings()
    # Each of the three managed indexes is present and synced.
    for name in (LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES):
        assert name in result, f"{name} missing from ensure_mappings result"
        assert result[name] == [], (
            f"{name} reported field additions on a freshly-created "
            f"index: {result[name]}"
        )


def test_missing_field_gets_added(es_indexes):
    """Drift simulation: delete the index, recreate it MINUS one
    field via a hand-built mapping, then assert ensure_mappings()
    detects the gap and fills it. This is the exact scenario the
    PO's dev ES hit when subject_label/object_label/predicate_violation
    landed without a corresponding mappings.py update.
    """
    from api.storage.elasticsearch import indexes
    from api.storage.elasticsearch.client import (
        LUCID_FACTS,
        get_client,
    )
    from api.storage.elasticsearch.mappings import LUCID_FACTS_MAPPING

    client = get_client()

    # Recreate lucid_facts with subject_label stripped from the
    # declared mapping. The other fields land as declared.
    stripped = {
        "settings": LUCID_FACTS_MAPPING["settings"],
        "mappings": {
            "dynamic": "strict",
            "properties": {
                k: v
                for k, v in LUCID_FACTS_MAPPING["mappings"]["properties"].items()
                if k != "subject_label"
            },
        },
    }
    try:
        client.indices.delete(index=LUCID_FACTS)
        client.indices.create(index=LUCID_FACTS, body=stripped)

        # Pre-condition: subject_label is NOT on the live mapping.
        live = client.indices.get_mapping(index=LUCID_FACTS)
        live_props = (
            live.get(LUCID_FACTS, {}).get("mappings", {}).get("properties", {})
        )
        assert "subject_label" not in live_props

        # Act
        result = indexes.ensure_mappings()

        # Post-condition: subject_label is now on the live mapping AND
        # the result reports the addition.
        live = client.indices.get_mapping(index=LUCID_FACTS)
        live_props = (
            live.get(LUCID_FACTS, {}).get("mappings", {}).get("properties", {})
        )
        assert "subject_label" in live_props
        assert "subject_label" in result[LUCID_FACTS]
    finally:
        # Always restore the canonical mapping so downstream tests see
        # a clean index even if an assertion above fires.
        if client.indices.exists(index=LUCID_FACTS):
            client.indices.delete(index=LUCID_FACTS)
        indexes.create_indexes(names=[LUCID_FACTS])


def test_missing_index_is_skipped(es_indexes):
    """If an index doesn't exist, ensure_mappings skips it entirely
    rather than creating it (creation is create_indexes' job, not
    ensure_mappings'). Skipped indexes are absent from the result dict.
    """
    from api.storage.elasticsearch import indexes
    from api.storage.elasticsearch.client import LUCID_SOURCES, get_client

    client = get_client()
    try:
        if client.indices.exists(index=LUCID_SOURCES):
            client.indices.delete(index=LUCID_SOURCES)
        assert not client.indices.exists(index=LUCID_SOURCES)

        result = indexes.ensure_mappings()

        assert LUCID_SOURCES not in result, (
            "ensure_mappings should skip non-existent indexes "
            "(let create_indexes own creation)"
        )
    finally:
        # Always restore so downstream tests see lucid_sources back.
        indexes.create_indexes(names=[LUCID_SOURCES])


def test_put_mapping_failure_is_graceful(es_indexes):
    """If client.indices.put_mapping raises, ensure_mappings returns
    [] for that index without propagating — startup must not crash.

    We assert on the side effects (the missing field is NOT silently
    added; the function does not raise) rather than on a log record,
    because caplog plumbing under `logging.basicConfig` + pytest-asyncio
    is flaky across the integration runner.
    """
    from api.storage.elasticsearch import indexes
    from api.storage.elasticsearch.client import (
        LUCID_FACTS,
        get_client,
    )
    from api.storage.elasticsearch.mappings import LUCID_FACTS_MAPPING

    client = get_client()

    # Set up the drift scenario again so to_add is non-empty.
    stripped = {
        "settings": LUCID_FACTS_MAPPING["settings"],
        "mappings": {
            "dynamic": "strict",
            "properties": {
                k: v
                for k, v in LUCID_FACTS_MAPPING["mappings"]["properties"].items()
                if k != "predicate_violation"
            },
        },
    }
    try:
        client.indices.delete(index=LUCID_FACTS)
        client.indices.create(index=LUCID_FACTS, body=stripped)

        # Wrap the real client so put_mapping raises but everything else
        # passes through. We can't use monkeypatch as a fixture here
        # because we already use caplog; assemble a shim instead.
        class _BoomIndices:
            def __init__(self, real):
                self._real = real

            def exists(self, *args, **kwargs):
                return self._real.exists(*args, **kwargs)

            def get_mapping(self, *args, **kwargs):
                return self._real.get_mapping(*args, **kwargs)

            def put_mapping(self, *args, **kwargs):
                raise RuntimeError("simulated ES outage")

        shim_client = types.SimpleNamespace(indices=_BoomIndices(client.indices))

        # Must not raise.
        result = indexes.ensure_mappings(client=shim_client)

        assert result[LUCID_FACTS] == [], (
            "Failed put_mapping should not leak field names into the result"
        )

        # Side effect: the field was NOT silently added (no put_mapping
        # ever succeeded). The live mapping stays in its stripped state.
        live = client.indices.get_mapping(index=LUCID_FACTS)
        live_props = (
            live.get(LUCID_FACTS, {})
            .get("mappings", {})
            .get("properties", {})
        )
        assert "predicate_violation" not in live_props
    finally:
        # Always restore canonical mapping (the simulated put_mapping
        # failure leaves the stripped index in place).
        if client.indices.exists(index=LUCID_FACTS):
            client.indices.delete(index=LUCID_FACTS)
        indexes.create_indexes(names=[LUCID_FACTS])
