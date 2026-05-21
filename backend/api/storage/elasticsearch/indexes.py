"""Index lifecycle: create / delete / reindex.

`create_indexes()` is idempotent — calling it on a live cluster that
already has the indexes is a no-op. `delete_indexes()` is used by
integration test teardown and the (rare) reindex migration.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable

from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
)
from api.storage.elasticsearch.mappings import INDEX_MAPPINGS

logger = logging.getLogger("lucid.es.indexes")


def _ordered_index_names() -> list[str]:
    """Stable order for creation/deletion (matches INDEX_MAPPINGS keys)."""
    return [LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES]


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
