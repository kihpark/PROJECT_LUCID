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
