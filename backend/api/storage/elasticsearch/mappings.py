"""Index mappings for the three ES indexes.

Korean text fields use the `nori` analyzer (custom alias
`korean_analyzer`). Dense vectors use HNSW with cosine similarity.
The OpenAI `text-embedding-3-small` model returns 1536-dim vectors.

DR-053 / C-14: NO `valid_until`, `is_stale`, or `stale_at` fields.
`valid_from` is kept as context-only metadata.
"""
from __future__ import annotations

from typing import Any

EMBEDDING_DIMS = 1536  # OpenAI text-embedding-3-small

KOREAN_ANALYZER_SETTINGS: dict[str, Any] = {
    "analysis": {
        "analyzer": {
            "korean_analyzer": {
                "type": "custom",
                "tokenizer": "nori_tokenizer",
                "filter": ["lowercase"],
            }
        }
    }
}


LUCID_FACTS_MAPPING: dict[str, Any] = {
    "settings": KOREAN_ANALYZER_SETTINGS,
    "mappings": {
        "dynamic": "strict",
        "properties": {
            "fact_uid": {"type": "keyword"},
            "claim": {"type": "text", "analyzer": "korean_analyzer"},
            "claim_en": {"type": "text", "analyzer": "standard"},
            "type": {"type": "keyword"},
            "subject_uid": {"type": "keyword"},
            "predicate": {"type": "keyword"},
            "object_value": {"type": "keyword"},
            "valid_from": {"type": "date"},
            "validated_at": {"type": "date"},
            "validation_method": {"type": "keyword"},
            "validator_id": {"type": "keyword"},
            "source_uids": {"type": "keyword"},
            "tags": {"type": "keyword"},
            "aliases": {"type": "text", "analyzer": "korean_analyzer"},
            "override_warning": {"type": "boolean"},
            "edit_history": {
                "type": "nested",
                "properties": {
                    "from_claim": {"type": "text", "analyzer": "korean_analyzer"},
                    "to_claim": {"type": "text", "analyzer": "korean_analyzer"},
                    "edited_at": {"type": "date"},
                    "edited_by": {"type": "keyword"},
                },
            },
            "knowledge_space_id": {"type": "keyword"},
            "embedding": {
                "type": "dense_vector",
                "dims": EMBEDDING_DIMS,
                "index": True,
                "similarity": "cosine",
                "index_options": {
                    "type": "hnsw",
                    "m": 16,
                    "ef_construction": 100,
                },
            },
            "created_at": {"type": "date"},
            "updated_at": {"type": "date"},
        },
    },
}


LUCID_OBJECTS_MAPPING: dict[str, Any] = {
    "settings": KOREAN_ANALYZER_SETTINGS,
    "mappings": {
        "dynamic": "strict",
        "properties": {
            "object_uid": {"type": "keyword"},
            "class": {"type": "keyword"},
            "name": {
                "type": "text",
                "analyzer": "korean_analyzer",
                "fields": {"keyword": {"type": "keyword"}},
            },
            "name_en": {"type": "text", "analyzer": "standard"},
            "properties": {"type": "object", "dynamic": True},
            "fact_uids": {"type": "keyword"},
            "connected_objects": {
                "type": "nested",
                "properties": {
                    "target_uid": {"type": "keyword"},
                    "link_type": {"type": "keyword"},
                },
            },
            "embedding": {
                "type": "dense_vector",
                "dims": EMBEDDING_DIMS,
                "index": True,
                "similarity": "cosine",
            },
            "knowledge_space_id": {"type": "keyword"},
            "created_at": {"type": "date"},
            "updated_at": {"type": "date"},
        },
    },
}


LUCID_SOURCES_MAPPING: dict[str, Any] = {
    "settings": KOREAN_ANALYZER_SETTINGS,
    "mappings": {
        "dynamic": "strict",
        "properties": {
            "source_uid": {"type": "keyword"},
            "domain": {"type": "keyword"},
            "source_type": {"type": "keyword"},
            "url": {"type": "keyword"},
            "title": {"type": "text", "analyzer": "korean_analyzer"},
            "first_captured_at": {"type": "date"},
            "capture_count": {"type": "integer"},
            "knowledge_space_id": {"type": "keyword"},
        },
    },
}


INDEX_MAPPINGS: dict[str, dict[str, Any]] = {
    "lucid_facts": LUCID_FACTS_MAPPING,
    "lucid_objects": LUCID_OBJECTS_MAPPING,
    "lucid_sources": LUCID_SOURCES_MAPPING,
}
