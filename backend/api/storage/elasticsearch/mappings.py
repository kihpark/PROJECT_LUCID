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
    LUCID_APPLICATIONS,
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
            # B-62 natural-spo-display - natural-English predicate
            # surface preserved verbatim for the recall display.
            # NEVER participates in the canonical_key dedup; that
            # key is (subject_uid, predicate_code, object_canonical).
            "predicate_label": {"type": "text", "analyzer": "standard"},
            "object_value": {"type": "keyword"},
            "valid_from": {"type": "date"},
            "validated_at": {"type": "date"},
            "validation_method": {"type": "keyword"},
            "validator_id": {"type": "keyword"},
            "source_uids": {"type": "keyword"},
            # B-62 data bedrock — OPL controlled-vocabulary predicate
            # code. NULL on legacy facts captured before the OPL layer
            # landed; new captures fill it via the canonical_key util.
            "predicate_code": {"type": "keyword"},
            # B-62 data bedrock — raw user surface text (the literal
            # claim the user typed / pasted before normalization).
            # Indexed with korean_analyzer so morpheme search hits the
            # original phrasing even after `claim` is normalized.
            "original_surface": {"type": "text", "analyzer": "korean_analyzer"},
            # B-62 data bedrock — ISO 639-1 language code of the
            # capture (e.g. "ko", "en"). Drives downstream cross-
            # lingual fact collapse at the canonical-entity layer.
            "capture_lang": {"type": "keyword"},
            # B-62 structure-resolve - canonical S-P-O object segment
            # (entity:<uid> | literal:<normalized-value>). The dedup
            # gate in `insert_or_dedup_fact` filters on this field
            # together with predicate_code so two captures of the same
            # canonical triple collapse to one ES doc.
            "object_canonical": {"type": "keyword"},
            # B-62 structure-resolve - full canonical_key
            # `<subject_uid>|<predicate_code>|<object_canonical>`.
            "canonical_key": {"type": "keyword"},
            # B-62 structure-resolve - HITL surface flag. True when
            # the predicate degraded to RELATED_TO.
            "needs_review": {"type": "boolean"},
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
            # B-62 data bedrock — canonical primary label (additive
            # alongside `name`). text + keyword sub-field so the
            # Stellar-View renderer can do morpheme search AND exact
            # dedup on the canonical surface. NULL on legacy objects.
            "primary_label": {
                "type": "text",
                "analyzer": "korean_analyzer",
                "fields": {"keyword": {"type": "keyword"}},
            },
            # B-62 data bedrock — ISO 639-1 language of `primary_label`.
            # Drives cross-lingual canonical-entity collapse.
            "primary_lang": {"type": "keyword"},
            # B-62 data bedrock — canonical entity type (additive
            # alongside `class`). NULL on legacy objects; the OPL
            # vocabulary supplies the controlled value set later.
            "entity_type": {"type": "keyword"},
            # B-52: surface-form aliases so a Korean query matches an
            # entity normalized into English (or vice versa). text with
            # korean_analyzer for substring / morpheme matching, plus a
            # keyword sub-field for exact-match dedup checks.
            "aliases": {
                "type": "text",
                "analyzer": "korean_analyzer",
                "fields": {"keyword": {"type": "keyword"}},
            },
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


# B-62 landing-integration: public beta-applicant intake from the
# v8.2 landing page. strict_dynamic mapping; no Korean analyzer
# (q1/q2 free-text is short, mixed-language is fine on standard).
LUCID_APPLICATIONS_MAPPING: dict[str, Any] = {
    "mappings": {
        "dynamic": "strict",
        "properties": {
            "application_id": {"type": "keyword"},
            "email": {"type": "keyword"},
            "email_lower": {"type": "keyword"},
            "display_name": {"type": "text"},
            "lang": {"type": "keyword"},
            "survey_q1_key": {"type": "keyword"},
            "survey_q1_value": {"type": "text"},
            "survey_q2_key": {"type": "keyword"},
            "survey_q2_value": {"type": "text"},
            "status": {"type": "keyword"},
            "submitted_at": {"type": "date"},
            "submitter_ip_hash": {"type": "keyword"},
            "user_agent": {"type": "text"},
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
    LUCID_APPLICATIONS: LUCID_APPLICATIONS_MAPPING,
}
