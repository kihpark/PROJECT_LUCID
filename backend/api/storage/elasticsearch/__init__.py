"""Lucid Elasticsearch storage layer.

PR-1A-3: 3 indexes (lucid_facts, lucid_objects, lucid_sources) +
CRUD + 1-hop traversal + kNN + Korean nori text search.

All queries require knowledge_space_id; global cross-space queries
are forbidden (security: per-user data isolation).
"""
from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
    reset_client,
)
from api.storage.elasticsearch.indexes import (
    create_indexes,
    delete_indexes,
    ensure_negation_fields,
    reindex_all,
)
from api.storage.elasticsearch.mappings import (
    INDEX_MAPPINGS,
    LUCID_FACTS_MAPPING,
    LUCID_OBJECTS_MAPPING,
    LUCID_SOURCES_MAPPING,
)

__all__ = [
    "LUCID_FACTS",
    "LUCID_OBJECTS",
    "LUCID_SOURCES",
    "get_client",
    "reset_client",
    "create_indexes",
    "delete_indexes",
    "reindex_all",
    "ensure_negation_fields",
    "INDEX_MAPPINGS",
    "LUCID_FACTS_MAPPING",
    "LUCID_OBJECTS_MAPPING",
    "LUCID_SOURCES_MAPPING",
]
