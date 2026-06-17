"""Index mappings for the three ES indexes.

Korean text fields use the `nori` analyzer (custom alias
`korean_analyzer`). Dense vectors use HNSW with cosine similarity.
The OpenAI `text-embedding-3-small` model returns 1536-dim vectors.

DR-053 / C-14: NO `valid_until`, `is_stale`, or `stale_at` fields.
`valid_from` is kept as context-only metadata.
"""
from __future__ import annotations

from typing import Any

from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
)

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
            "negation_flag": {"type": "boolean"},
            "negation_scope": {"type": "keyword"},
            "edit_history": {
                "type": "nested",
                "properties": {
                    "from_claim": {"type": "text", "analyzer": "korean_analyzer"},
                    "to_claim": {"type": "text", "analyzer": "korean_analyzer"},
                    "edited_at": {"type": "date"},
                    "edited_by": {"type": "keyword"},
                },
            },
            # B-48a soft-delete scaffold (UI in B-48b). When set, recall
            # filters this fact out by default; ?include_retracted=true
            # surfaces it again. retracted_by carries the actor uid so
            # B-48b can show "you retracted this on ..." in the detail
            # panel and offer restore.
            "retracted_at": {"type": "date"},
            "retracted_by": {"type": "keyword"},
            # B-48a Phase 1 placeholder for the locator layer (Phase 2
            # fills char_start / char_end / quote for text, and Phase 3
            # adds image regions / video timecodes). Stored as a nested
            # list of objects keyed by `kind` so future modalities can
            # add fields without a mapping break.
            "locators": {
                "type": "nested",
                "properties": {
                    "kind": {"type": "keyword"},
                    "source_uid": {"type": "keyword"},
                    "char_start": {"type": "integer"},
                    "char_end": {"type": "integer"},
                    "quote": {"type": "text", "analyzer": "korean_analyzer"},
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
                    # DCR-002 v2 / DR-066 — optional free-form modifier
                    "link_nuance": {"type": "keyword"},
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
            # B-48a reference layer expansion: the Source doc now
            # tracks the originating SourceJob (so the detail panel can
            # offer snapshot lookup against raw_payload), per-fact
            # capture timestamp (different from first_captured_at when
            # the same URL is captured multiple times), and author for
            # attribution. published_at is the article's stated date,
            # captured_at is when the user saved it.
            "source_job_id": {"type": "keyword"},
            "captured_at": {"type": "date"},
            "published_at": {"type": "date"},
            "author": {"type": "keyword"},
        },
    },
}


INDEX_MAPPINGS: dict[str, dict[str, Any]] = {
    # B-38: keys reflect the LUCID_INDEX_PREFIX in effect at import,
    # so create_indexes() / delete_indexes() looking up by prefixed
    # name (e.g. "test_lucid_facts") still find the mapping.
    LUCID_FACTS: LUCID_FACTS_MAPPING,
    LUCID_OBJECTS: LUCID_OBJECTS_MAPPING,
    LUCID_SOURCES: LUCID_SOURCES_MAPPING,
}
