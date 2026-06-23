"""Index lifecycle: create / delete / reindex.

`create_indexes()` is idempotent — calling it on a live cluster that
already has the indexes is a no-op. `delete_indexes()` is used by
integration test teardown and the (rare) reindex migration.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable

from api.storage.elasticsearch.client import (
    LUCID_APPLICATIONS,
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
)
from api.storage.elasticsearch.mappings import INDEX_MAPPINGS

logger = logging.getLogger("lucid.es.indexes")


def _ordered_index_names() -> list[str]:
    """Stable order for creation/deletion (matches INDEX_MAPPINGS keys).

    B-62 landing-integration: LUCID_APPLICATIONS appended at the end so
    create_indexes() covers it on app boot. The 3-index smoke contract
    (facts / objects / sources) is unchanged — the smoke check does not
    iterate over this list.
    """
    return [LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES, LUCID_APPLICATIONS]


# feat/landing-fix-spec: applications-only mapping reconciler. The
# v8.2 landing form schema flipped from {display_name, survey_q1_*,
# survey_q2_*} to flat {profession, q1, q2} + server meta
# (source / status / created_at). On dev clusters that already have
# the legacy mapping baked in, ES rejects the new strict_dynamic
# writes with `strict_dynamic_mapping_exception`. Recreating is safe
# because no production applicants exist yet — this index ships
# fresh with the PO-final shape.
_LEGACY_APPLICATION_KEYS = {
    "display_name",
    "survey_q1_key", "survey_q1_value",
    "survey_q2_key", "survey_q2_value",
    "submitted_at",
}
_REQUIRED_APPLICATION_KEYS = {"profession", "q1", "q2", "source", "created_at"}


def _applications_mapping_needs_recreate(client, index_name: str) -> bool:
    """True if `lucid_applications` is on the pre-fix-spec mapping.

    Triggers a destructive recreate when ANY legacy key is present OR
    ANY required new key is absent. Other indexes use the no-op
    'exists' path in create_indexes() — this helper is wired only
    for LUCID_APPLICATIONS.
    """
    if not client.indices.exists(index=index_name):
        return False
    try:
        mapping = client.indices.get_mapping(index=index_name)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "applications mapping inspect failed for %s: %s — leaving as-is",
            index_name, exc,
        )
        return False
    props = (
        mapping.get(index_name, {})
        .get("mappings", {})
        .get("properties", {})
    )
    present = set(props.keys())
    legacy_hits = present & _LEGACY_APPLICATION_KEYS
    missing_required = _REQUIRED_APPLICATION_KEYS - present
    return bool(legacy_hits) or bool(missing_required)



def create_indexes(names: Iterable[str] | None = None) -> dict[str, str]:
    """Create the requested indexes (or all three by default).

    Returns a dict mapping each index name to a status string:
    'created' | 'exists'.
    """
    names = list(names) if names is not None else _ordered_index_names()
    client = get_client()
    result: dict[str, str] = {}
    for name in names:
        if name not in INDEX_MAPPINGS:
            raise ValueError(f"Unknown index: {name}")
        # feat/landing-fix-spec: applications-only legacy-mapping check.
        if (
            name == LUCID_APPLICATIONS
            and _applications_mapping_needs_recreate(client, name)
        ):
            logger.warning(
                "Index %s has legacy/incomplete mapping — recreating", name,
            )
            client.indices.delete(index=name)
        if client.indices.exists(index=name):
            result[name] = "exists"
            logger.info("Index %s already present, skipping", name)
            continue
        client.indices.create(index=name, body=INDEX_MAPPINGS[name])
        result[name] = "created"
        logger.info("Created index %s", name)
    return result


def delete_indexes(names: Iterable[str] | None = None) -> dict[str, str]:
    """Drop the listed indexes (default: all three). Idempotent."""
    names = list(names) if names is not None else _ordered_index_names()
    client = get_client()
    result: dict[str, str] = {}
    for name in names:
        if not client.indices.exists(index=name):
            result[name] = "absent"
            continue
        client.indices.delete(index=name)
        result[name] = "deleted"
        logger.info("Deleted index %s", name)
    return result


def reindex_all() -> dict[str, str]:
    """Convenience: drop then re-create all three indexes.

    Used by the (rare) schema-migration path in dev. NOT idempotent on
    documents — data is lost. Never call from runtime code; only from
    a one-off migration script.
    """
    delete_indexes()
    return create_indexes()


def ensure_mappings(client=None, *, mappings_module=None) -> dict[str, list[str]]:
    """Non-destructive mapping sync for facts/objects/sources.

    feat/mappings-sync-permanent (2026-06-23): codifies the runtime
    `put_mapping` reconciliation we ran against PO's dev ES when the
    `lucid_objects` / `lucid_facts` indexes drifted behind the writer
    code (entity-resolver added `primary_label` / `primary_lang`;
    spo-decide-payload-wire added `subject_label` / `object_label` /
    `predicate_violation`). Without this hook, the next mapping
    drift between a live cluster and the declared file would crash
    every `bulk_create_facts` call with `strict_dynamic_mapping_exception`.

    For each declared index mapping (facts / objects / sources) we
    fetch the LIVE properties and PUT any properties that are
    declared in code but missing on the cluster. Existing data is
    preserved — ES `put_mapping` is additive at the leaf-field level.

    Intentionally does NOT extend the destructive
    `_applications_mapping_needs_recreate` detector to facts /
    objects — those indexes hold real PO data and must never be
    silently dropped.

    The lucid_applications index is excluded because its strict-shape
    legacy handling is already covered by the destructive detector
    above; mixing the two would mask legacy-key drift.

    Returns dict { index_name: [field, ...] } listing fields newly
    added per index. An empty list means the live mapping already
    matches the declared one. Missing indexes are absent from the
    return dict entirely (caller can join against `create_indexes()`
    output to distinguish missing-index from already-synced).
    """
    if client is None:
        client = get_client()
    if mappings_module is None:
        from api.storage.elasticsearch import mappings as mappings_module

    declared: dict[str, dict] = {
        LUCID_FACTS: mappings_module.LUCID_FACTS_MAPPING,
        LUCID_OBJECTS: mappings_module.LUCID_OBJECTS_MAPPING,
        LUCID_SOURCES: mappings_module.LUCID_SOURCES_MAPPING,
    }

    added: dict[str, list[str]] = {}
    for index_name, declared_mapping in declared.items():
        if not client.indices.exists(index=index_name):
            continue
        try:
            live = client.indices.get_mapping(index=index_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "ensure_mappings: get_mapping failed for %s: %s — skipping",
                index_name, exc,
            )
            added[index_name] = []
            continue
        live_props = (
            live.get(index_name, {})
            .get("mappings", {})
            .get("properties", {})
        )
        declared_props = (
            declared_mapping.get("mappings", {}).get("properties", {})
        )
        to_add = {
            k: v for k, v in declared_props.items() if k not in live_props
        }
        if not to_add:
            added[index_name] = []
            continue
        try:
            client.indices.put_mapping(index=index_name, properties=to_add)
            added[index_name] = list(to_add.keys())
            logger.info(
                "ensure_mappings: added %d field(s) to %s: %s",
                len(to_add), index_name, list(to_add.keys()),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "ensure_mappings: put_mapping failed for %s "
                "(fields=%s): %s",
                index_name, list(to_add.keys()), exc,
            )
            added[index_name] = []
    return added


def ensure_negation_fields() -> dict[str, str]:
    """Idempotent: add negation_flag + negation_scope to lucid_facts.

    For DCR-001. Existing clusters with the old mapping get the new
    fields added via the put_mapping API; new clusters get them
    automatically through create_indexes(). Safe to run on every boot.

    Returns a dict { index_name: 'added' | 'present' | 'missing-index' }.
    """
    client = get_client()
    if not client.indices.exists(index=LUCID_FACTS):
        return {LUCID_FACTS: "missing-index"}
    current = client.indices.get_mapping(index=LUCID_FACTS)
    props = (
        current.get(LUCID_FACTS, {})
        .get("mappings", {})
        .get("properties", {})
    )
    if "negation_flag" in props and "negation_scope" in props:
        return {LUCID_FACTS: "present"}
    client.indices.put_mapping(
        index=LUCID_FACTS,
        properties={
            "negation_flag": {"type": "boolean"},
            "negation_scope": {"type": "keyword"},
        },
    )
    logger.info("Added negation_flag + negation_scope to %s", LUCID_FACTS)
    return {LUCID_FACTS: "added"}
