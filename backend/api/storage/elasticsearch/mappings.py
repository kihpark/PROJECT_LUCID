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
            # B-62 spo-decide-payload-wire / mappings-sync-permanent
            # (2026-06-23) - Decide-UI display labels resolved at fact-
            # serialize time. The Decide UI reads these directly when
            # present (else falls back to `subject_uid` / `object_value`).
            # Keyword because the writer emits a normalized surface
            # string, not free-text — exact-match recall + facet display
            # only.
            "subject_label": {"type": "keyword"},
            "object_label": {"type": "keyword"},
            # B-62 spo-decide-payload-wire / mappings-sync-permanent
            # (2026-06-23) - True when `detect_predicate_violation` fires
            # at fact-serialize time (subject/object class violates the
            # predicate's OPL constraint). The Decide UI shows a warning
            # chip; recall does not filter on it. Independent of
            # `needs_review` (which fires on RELATED_TO degrade).
            "predicate_violation": {"type": "boolean"},
            "tags": {"type": "keyword"},
            "aliases": {"type": "text", "analyzer": "korean_analyzer"},
            "override_warning": {"type": "boolean"},
            "negation_flag": {"type": "boolean"},
            "negation_scope": {"type": "keyword"},
            # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split.
            # `fact_type` keyword (action | claim | measurement) drives the
            # recall facet bucket. The 5 claim-only fields are populated by
            # the LLM only when fact_type=='claim'; legacy / action / measurement
            # docs leave them null. `speech_act` is open natural-language —
            # keyword for exact-match facet/aggregation, NOT a controlled enum.
            "fact_type": {"type": "keyword"},
            "speaker_uid": {"type": "keyword"},
            "speaker_label": {"type": "keyword"},
            "speech_act": {"type": "keyword"},
            "content_claim": {"type": "text", "analyzer": "korean_analyzer"},
            "stance": {"type": "keyword"},
            # v0.2.0 step 2 (fact-measurement-layer-v1): measurement layer.
            # 4 fields populated only when fact_type=='measurement'.
            # `metric` is OPEN Korean / source-language string — keyword for
            # exact-match facet, no controlled vocabulary at extraction time.
            # `measurement_value` is the numeric value (8e8 for MAU, 70 for
            # 매출 70 조 원, 3.4 for 실업률 3.4%). Stored as `double` so
            # ES range queries and future time-series aggregations land
            # without precision surprises.
            # `measurement_unit` is the OPEN string companion ("명", "조 원",
            # "%", "달러"); keyword for facet bucket on unit-of-measure.
            # `as_of` is the timepoint — accepts year / year-month / quarter /
            # date granularity. Kept as keyword (not date) because the LLM
            # emits ranges / approximations no single date format covers.
            "metric": {"type": "keyword"},
            "measurement_value": {"type": "double"},
            "measurement_unit": {"type": "keyword"},
            "as_of": {"type": "keyword"},
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
            # m32a-stage2-role-channel (PO 2026-06-28 decision 4):
            # multi-participant fact role channel. The outer LUCID_FACTS
            # mapping is dynamic='strict', so this field must be declared
            # explicitly — but the nested `dynamic: True` opens the gate
            # so new role keys (beyond the seed recipient/instrument/
            # location) get auto-indexed as keyword. ★ Enum 경직 금지:
            # the LLM is allowed to emit "witness", "topic", "co-actor"
            # etc and the field carries them through without a mapping
            # migration. Seed 3 roles are declared so facet queries on
            # the common cases keep their explicit type.
            #
            # The discovery report (docs/m3-2a-discovery.md C.2) measured
            # that 100% of current `involves` links carry properties={}
            # — multi-participant facts (e.g. "모스 탄이 6·3선거를
            # 트럼프에게 알렸다", trump=recipient) lose the auxiliary
            # participant entirely. This field plugs that gap by
            # storing roles directly on the fact doc.
            "fact_object_role": {
                "type": "object",
                "dynamic": True,
                "properties": {
                    "recipient": {"type": "keyword"},
                    "instrument": {"type": "keyword"},
                    "location": {"type": "keyword"},
                },
            },
            # m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6):
            # CLAIM 의 내용 속 entity 들 (예: "모스 탄이 aweb이 6·3선거와
            # 관련있다 주장" → related=[aweb, 6·3선거]).
            # 같은 fact 안 array — ★ 별도 doc 아님 (성능 + 단순성).
            #
            # ★ provenance 게이트 (P2 가 구조에 박힘): 이 link 들은
            # 검증된 사실이 아니라 claim 노드를 경유한 "주장된 연결".
            # AI/시스템이 미검증 entity 관계를 실선으로 못 그음 —
            # 점선 related-to 의 데이터 표현. Stage 4 의 link_status
            # (verified/claimed) 가 이 array 위에 얹혀 점/실선을 결정.
            #
            # 의뢰서 acceptance: "aweb 관련 주장" = claim 노드
            # (점선 related-to). 의뢰서 example: [모스 탄] ─speaker─>
            # claim ─related-to─> [6·3선거][aweb].
            #
            # 비-claim fact (action / measurement) 에서는 비어 있거나
            # 누락 — recall facet 은 keyword null 을 missing 으로
            # 처리하므로 별도 분기 없이 OK.
            "related_entity_uids": {"type": "keyword"},
            # M3-1 canonical-layer apply — fact provenance after entity merge.
            # When a fact's subject_uid/object was rewritten to point at a
            # canonical target, this records the original object_uid + merge
            # timestamp so a rollback can reconstruct the pre-merge state.
            "canonical_merge_provenance": {
                "type": "object",
                "properties": {
                    "original_object_uid": {"type": "keyword"},
                    "merged_into": {"type": "keyword"},
                    "merged_at": {"type": "date"},
                },
            },
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
            # B-62-fix legacy-korean-relabel - nested audit trail of
            # primary_label swaps performed by the backfill script in
            # backend/scripts/relabel_legacy_korean_entities.py. NULL
            # on objects that were never relabeled; entries grow only
            # when the script promotes a Korean alias to primary. The
            # field is additive - live indexes created before this
            # ticket pick it up via the script's put_mapping call.
            "relabel_history": {
                "type": "nested",
                "properties": {
                    "at": {"type": "date"},
                    "from_primary": {"type": "keyword"},
                    "to_primary": {"type": "keyword"},
                    "reason": {"type": "keyword"},
                },
            },
            # M3-1 canonical-layer apply (PO 2026-06-27 ok apply) —
            # canonical_uid: 이 doc 의 canonical 대표 (병합 후 모든 member
            #   doc 이 surviving target 의 object_uid 를 가르킴).
            # retired_by_merge: 이 doc 가 다른 canonical 로 흡수되어 더 이상
            #   primary 가 아님 (병합 시 only set on member docs, target 은 null).
            "canonical_uid": {"type": "keyword"},
            "retired_by_merge": {"type": "date"},
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


# B-62 landing-integration + feat/landing-fix-spec: public beta
# applicant intake from the v8.2 landing page. strict_dynamic
# mapping; no Korean analyzer (q1/q2 free-text is short, mixed
# language is fine on standard).
#
# Shape (PO final): flat 4-field form (email, profession, q1, q2)
# plus server-set meta (source / status / created_at /
# submitter_ip_hash / user_agent / lang).
#
# Migrated from landing-integration:
#   - dropped: display_name, survey_q1_key, survey_q1_value,
#     survey_q2_key, survey_q2_value
#   - added:   profession (text), q1 (text), q2 (text),
#              source (keyword)
#   - renamed: submitted_at -> created_at
# fix-admission depends on `status` (keyword), `source` (keyword),
# `created_at` (date) so the review queue can filter cleanly.
LUCID_APPLICATIONS_MAPPING: dict[str, Any] = {
    "mappings": {
        "dynamic": "strict",
        "properties": {
            "application_id": {"type": "keyword"},
            "email": {"type": "keyword"},
            "email_lower": {"type": "keyword"},
            "profession": {"type": "text"},
            "q1": {"type": "text"},
            "q2": {"type": "text"},
            "lang": {"type": "keyword"},
            "source": {"type": "keyword"},
            "status": {"type": "keyword"},
            "created_at": {"type": "date"},
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
