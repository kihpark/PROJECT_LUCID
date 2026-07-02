"""Recall — dogfood thin slice (DR-089).

A single endpoint:

  GET /api/spaces/{space_id}/recall?q=<query>

Pipeline:
  1. Authorise space ownership (KnowledgeSpace.user_id == current user)
  2. Embed the query via the existing OpenAI embedding helper
  3. kNN against `lucid_facts` with three hard filters:
        knowledge_space_id == :space_id
        validation_method  == 'manual'              <- MUST. Non-manual
                                                       FactNodes are NEVER
                                                       returned. This is the
                                                       zero-hallucination
                                                       guarantee.
        score              >= RECALL_SCORE_FLOOR
  4. Build the response envelope with the signature line.

When the query yields no facts (zero stored OR all under threshold),
the response is identical: facts=[], signature="검증된 사실이 없습니다".
The route MUST NOT paraphrase or generate. The branding of the
endpoint is "if we did not see it, we will not say it."
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from api.models.recall import (
    DetachSourceRequest,
    EntityBrief,
    EntityBriefGroup,
    EntityFacetItem,
    EntityFacets,
    EntityFactRef,
    FactDetailEntity,
    FactDetailHeader,
    FactDetailResponse,
    FactDetailSource,
    FactMutationResponse,
    FactsList,
    FactTypeFacets,
    LedgerItem,
    LedgerResponse,
    ModifyFactRequest,
    PredicateFacetItem,
    RecallBriefingResponse,
    RecallFacets,
    RecallFact,
    RecallResponse,
)
from api.security import get_current_user
from api.storage.elasticsearch.client import LUCID_FACTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.elasticsearch.facts import get_fact_by_uid
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.recall")

router = APIRouter(prefix="/api/spaces/{space_id}", tags=["recall"])


# cosine similarity scored in ES: (1 + cos) / 2 → [0, 1]. 0.5 = orthogonal.
# 0.72 = empirically "topically related" floor (see Sprint 5 design notes).
RECALL_SCORE_FLOOR = 0.72
RECALL_DEFAULT_K = 10
RECALL_MAX_K = 50


SIGNATURE_HIT_TEMPLATE = (
    "As far as I know — 그래프에 {n}개 검증 "
    "사실이 있습니다"
)
SIGNATURE_EMPTY = "검증된 사실이 없습니다"


def _new_session() -> Any:
    return make_sessionmaker()()


def _resolve_space(session: Any, space_id: uuid.UUID, user: User) -> KnowledgeSpace:
    ks = session.get(KnowledgeSpace, space_id)
    if ks is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="space_not_found",
        )
    if ks.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="forbidden",
        )
    return ks


def _empty(reason: str) -> RecallResponse:
    logger.info("recall: empty result (%s)", reason)
    return RecallResponse(signature=SIGNATURE_EMPTY, facts=[], total=0)


# A canonical Object uid produced by new_uid() in api.models.base is a
# UUID4 hex string ("550e8400-e29b-41d4-a716-446655440000"). This regex
# screens object_value to decide whether it carries an entity ref (and
# should participate in the expansion) or a literal ("85.7 billion USD",
# "흑자") that must NOT be looked up as an entity. The LLM placeholder
# "obj-N" is also accepted as a fallback for any FactNode written before
# B-35's remap (it's harmless to query against — no hit means no link).
_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_OBJ_PLACEHOLDER_RE = re.compile(r"^obj-\d+$", re.IGNORECASE)


def _is_entity_ref(value: str | None) -> bool:
    """True iff `value` looks like an Object uid (UUID4 or LLM-
    placeholder obj-N). Literals always return False so they're
    never used as ES `terms` lookup keys."""
    if not value:
        return False
    return bool(_UUID4_RE.match(value) or _OBJ_PLACEHOLDER_RE.match(value))


# search-embedding-restore (v0.2.0 graduation gate) — confidence guards.
#
# PO repro: searching "선거관리위원회" returned "최저임금위원회". Root cause:
# (a) every fact's embedding field was empty (fixed on the write side) so
# the kNN pass returned zero hits, then (b) the entity-name fallback's
# tier-3 wildcard `*위원회*` matched ANY entity sharing the substring.
#
# These two helpers gate each fallback so a low-confidence match is
# silenced rather than rendered. PO philosophy: 知之爲知之 — better
# silence than a wrong fact.
#
# `_is_kNN_meaningful` is largely redundant with RECALL_SCORE_FLOOR
# (already filters kNN hits below 0.72) but stays as a belt-and-braces
# check on the raw _score before threshold logic — useful when callers
# override the threshold to 0 for debugging.
#
# `_entity_match_is_confident` uses bigram (n=2) Jaccard. For the PO
# repro: "선거관리위원회"↔"최저임금위원회" share only the "위원회" trigram
# region — bigrams {위원, 원회} of 6 vs 6 → Jaccard ≈ 2/10 = 0.20. Same
# query against itself → 1.0. Threshold 0.6 cleanly separates them.

def _is_kNN_meaningful(hits: list[dict], threshold: float = 0.3) -> bool:
    if not hits:
        return False
    top = hits[0].get("_score", 0.0)
    return top >= threshold


def _entity_match_is_confident(
    query: str, matched_entity_name: str, threshold: float = 0.6,
) -> bool:
    def ngrams(text: str, n: int = 2) -> set[str]:
        text = (text or "").strip()
        if len(text) >= n:
            return {text[i : i + n] for i in range(len(text) - n + 1)}
        return {text} if text else set()

    q_grams = ngrams(query)
    m_grams = ngrams(matched_entity_name)
    if not q_grams or not m_grams:
        return False
    jaccard = len(q_grams & m_grams) / len(q_grams | m_grams)
    return jaccard >= threshold


def _collect_entity_uids(facts: list[RecallFact]) -> list[str]:
    """Extract the unique set of entity uids referenced by `facts`
    (subject_uid always counts; object_value only when it's shaped
    like an entity ref). Order is preserved so the same query is
    deterministic across runs — useful for caching at a later stage."""
    seen: dict[str, None] = {}
    for f in facts:
        if f.subject_uid and f.subject_uid not in seen:
            seen[f.subject_uid] = None
        if f.object_value and _is_entity_ref(f.object_value):
            if f.object_value not in seen:
                seen[f.object_value] = None
    return list(seen.keys())


def _retracted_clause(include_retracted: bool) -> dict[str, Any] | None:
    """B-48a soft-delete filter. Default: hide facts with retracted_at
    set. `include_retracted=True` removes the filter so the (future)
    "철회된 사실 보기" toggle can surface them again."""
    if include_retracted:
        return None
    return {"bool": {"must_not": [{"exists": {"field": "retracted_at"}}]}}


def _date_range_filter(
    date_from: datetime | None, date_to: datetime | None,
) -> dict[str, Any] | None:
    """B-50: build an ES range clause for validated_at, or None when
    both bounds are absent. Inclusive on both sides; either side may
    be omitted."""
    if date_from is None and date_to is None:
        return None
    bounds: dict[str, Any] = {}
    if date_from is not None:
        bounds["gte"] = date_from.isoformat()
    if date_to is not None:
        bounds["lte"] = date_to.isoformat()
    return {"range": {"validated_at": bounds}}


def _entity_link_facts(
    entity_uids: list[str],
    knowledge_space_id: str,
    *,
    exclude_fact_uids: set[str],
    max_hits: int = 50,
    include_retracted: bool = False,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return hit dicts for every validated fact whose subject_uid OR
    object_value matches any of `entity_uids`. Excludes facts already
    in the embedding pass.

    B-48a: retracted facts (retracted_at != null) are filtered out by
    default; pass `include_retracted=True` to surface them.

    B-50: optional `date_from` / `date_to` clip the result set to a
    validated_at window. Both bounds inclusive."""
    if not entity_uids:
        return []
    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": knowledge_space_id}},
        {"term": {"validation_method": "manual"}},
        {"bool": {
            "should": [
                {"terms": {"subject_uid": entity_uids}},
                {"terms": {"object_value": entity_uids}},
            ],
            "minimum_should_match": 1,
        }},
    ]
    retract = _retracted_clause(include_retracted)
    if retract is not None:
        filters.append(retract)
    date_clause = _date_range_filter(date_from, date_to)
    if date_clause is not None:
        filters.append(date_clause)
    body: dict[str, Any] = {
        "query": {"bool": {"filter": filters}},
        "size": max_hits,
    }
    client = get_client()
    resp = client.search(index=LUCID_FACTS, body=body)
    hits = list(resp["hits"]["hits"])
    out: list[dict[str, Any]] = []
    for h in hits:
        src = h.get("_source") or {}
        if src.get("fact_uid") in exclude_fact_uids:
            continue
        out.append(h)
    return out


def _knn_facts_validated_only(
    embedding: list[float],
    knowledge_space_id: str,
    k: int,
    *,
    entity_filter_uids: list[str] | None = None,
    include_retracted: bool = False,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> list[dict[str, Any]]:
    """ES kNN with hard filters: space + validation_method=manual.

    B-49: when `entity_filter_uids` is supplied, every hit MUST
    reference EVERY entity uid on subject_uid OR object_value (AND
    intersection). Pure ES query — no app-side loop.

    B-48a: retracted facts are filtered out by default.
    B-50: optional date_from / date_to clip validated_at inclusively.
    """
    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": knowledge_space_id}},
        {"term": {"validation_method": "manual"}},
    ]
    for uid in entity_filter_uids or []:
        filters.append({"bool": {"should": [
            {"term": {"subject_uid": uid}},
            {"term": {"object_value": uid}},
        ], "minimum_should_match": 1}})
    retract = _retracted_clause(include_retracted)
    if retract is not None:
        filters.append(retract)
    date_clause = _date_range_filter(date_from, date_to)
    if date_clause is not None:
        filters.append(date_clause)
    body: dict[str, Any] = {
        "knn": {
            "field": "embedding",
            "query_vector": embedding,
            "k": k,
            "num_candidates": max(50, k * 5),
            "filter": filters,
        },
        "size": k,
    }
    client = get_client()
    resp = client.search(index=LUCID_FACTS, body=body)
    return list(resp["hits"]["hits"])


def _hit_to_fact(hit: dict[str, Any]) -> RecallFact | None:
    """Convert an ES hit dict into a RecallFact. Returns None on any
    schema violation so a malformed row never breaks the response."""
    source = hit.get("_source") or {}
    if source.get("validation_method") != "manual":
        # Defensive: should be impossible because the filter is in the ES
        # query, but the zero-hallucination contract makes this a hard
        # invariant worth re-checking before serialising.
        logger.warning(
            "recall: dropping non-manual fact %s (validation_method=%r)",
            source.get("fact_uid"), source.get("validation_method"),
        )
        return None
    try:
        return RecallFact(
            fact_uid=source["fact_uid"],
            claim=source["claim"],
            claim_en=source.get("claim_en"),
            subject_uid=source["subject_uid"],
            predicate=source["predicate"],
            object_value=source["object_value"],
            source_uids=list(source.get("source_uids") or []),
            validated_at=source["validated_at"],
            validator_id=source["validator_id"],
            validation_method="manual",
            knowledge_space_id=source["knowledge_space_id"],
            negation_flag=bool(source.get("negation_flag", False)),
            negation_scope=source.get("negation_scope"),
            score=float(hit.get("_score") or 0.0),
            # B-62 natural-spo-display: surface the natural english
            # predicate gloss when the ES doc carries it. Legacy facts
            # leave it None and the frontend falls back to predicate.
            predicate_label=source.get("predicate_label"),
            # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim.
            # `fact_type` defaults to None on legacy docs; FactCard
            # treats null as 'action' (no badge, no claim strip).
            #
            # v0.2.0 step 2 (fact-measurement-layer-v1): measurement
            # bucket adds 4 more null-safe fields (metric / value /
            # unit / as_of). Null on action / claim / legacy docs.
            fact_type=source.get("fact_type"),
            speaker_label=source.get("speaker_label"),
            speech_act=source.get("speech_act"),
            content_claim=source.get("content_claim"),
            stance=source.get("stance"),
            metric=source.get("metric"),
            measurement_value=source.get("measurement_value"),
            measurement_unit=source.get("measurement_unit"),
            as_of=source.get("as_of"),
            # m3-2a STELLAR v2 (PO 2026-06-29) — pass-through 4 필드.
            # ES 에 이미 저장된 (processor.py:702/717/723) 필드를
            # frontend stellarRealAdapter v2 가 entity-edge / claim 그래프
            # 자동 정합에 사용. 옛 fact 에 없으면 default.
            speaker_uid=source.get("speaker_uid"),
            related_entity_uids=source.get("related_entity_uids") or [],
            fact_object_role=source.get("fact_object_role") or {},
            link_status=source.get("link_status"),
        )
    except (KeyError, ValueError, TypeError) as exc:
        logger.warning("recall: malformed fact source dropped: %s", exc)
        return None


def _resolve_label(entity_source: dict) -> str | None:
    """Cascade resolution for an entity's display label.

    fix/enrich-labels-cascade-fallback (PO 2026-07-01) — the previous
    single-field lookup (`name` only) surfaced None whenever a Korean
    entity was registered with the surface as `primary_label` but no
    canonical `name`, or vice versa. Symptom: `이재명 대통령` (uid
    466b13bb) had name='이재명 대통령', primary_label='이재명 대통령',
    canonical_name=None, and yet every fact referencing it came back
    with subject_label=None. 87/87 entities in the sweep had
    canonical_name=None.

    Cascade (first non-empty wins):
      1. canonical_name  — v0.2 canonical surface, usually None on
                           legacy docs but wins when the resolution
                           gateway has written it.
      2. name            — the classic lucid_objects surface.
      3. primary_label   — the B-62 canonical primary label field,
                           populated by the decomposer + relabel
                           backfill script.
      4. None            — last resort. The frontend renders "미해결
                           entity" so the miss stays visible instead
                           of silently degrading to a blank card.
    """
    return (
        entity_source.get("canonical_name")
        or entity_source.get("name")
        or entity_source.get("primary_label")
        or None
    )


def _enrich_with_labels(
    facts: list[RecallFact], knowledge_space_id: str,
) -> list[RecallFact]:
    """Look up the human-readable name AND entity_type for every entity
    uid the facts reference, then return a new list with subject_label /
    object_label / speaker_label / related_entity_labels /
    subject_entity_type / object_entity_type populated.

    Uses a single ES mget so the cost is one round-trip regardless of
    how many facts we resolve.

    Literals on `object_value` (anything that doesn't look like an
    entity ref) are left untouched — object_label / object_entity_type
    are None and the client renders the literal as-is.

    fix/m32b-entity-type-degree-actual-wiring (PO 2026-06-28): the same
    mget pass now also surfaces `class` (the v0.2 entity classifier
    output: person / organization / group / product / resource / concept
    / knowledge / event / place) as `subject_entity_type` /
    `object_entity_type`. The FE StellarGraph renderer's nodeColor
    callback branches on these to drive the M3-2b visual-vocabulary
    palette. Without this enrichment every node falls back to
    STELLAR_ACCENT and the PO's "entity별 구분이 제일 먼저 필요" gate
    stays unfulfilled.

    fix/enrich-labels-cascade-fallback (PO 2026-07-01): expanded to
    cover speaker_uid + related_entity_uids in the same mget pass, and
    routed every label resolution through `_resolve_label` so a Korean
    entity with only `primary_label` set still surfaces on the recall
    response. Symptom before the fix: 이재명 대통령 (uid 466b13bb) had
    4 facts, all with subject_label=None because the code read `name`
    exclusively and the resolution-gateway had never populated `name`
    for that doc. Cascade rescues canonical_name-missing / name-missing
    entities without a re-index.
    """
    if not facts:
        return facts

    uids: dict[str, None] = {}
    for f in facts:
        if f.subject_uid:
            uids[f.subject_uid] = None
        if f.object_value and _is_entity_ref(f.object_value):
            uids[f.object_value] = None
        # fix/enrich-labels-cascade-fallback: speaker_uid + related_entity_uids
        # go into the same mget batch so no extra ES round-trip is
        # incurred to resolve the claim-layer speaker / referenced
        # entities. Legacy facts without these fields simply skip.
        if f.speaker_uid:
            uids[f.speaker_uid] = None
        for ref_uid in (f.related_entity_uids or []):
            if ref_uid:
                uids[ref_uid] = None
    if not uids:
        return facts

    label_by_uid: dict[str, str] = {}
    # fix/m32b-entity-type-degree-actual-wiring: parallel dict mapping
    # entity uid -> classifier `class`. Populated from the same mget
    # response, so no extra ES round-trip. Missing/legacy docs simply
    # never land here -> downstream `.get(uid)` returns None and the
    # FE falls back to STELLAR_ACCENT.
    entity_type_by_uid: dict[str, str] = {}
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS
        client = get_client()
        # mget by id — when an id doesn't exist the hit is `found=False`
        # and we just skip it. Faster than running multiple `get` calls.
        resp = client.mget(
            index=LUCID_OBJECTS,
            body={"ids": list(uids.keys())},
        )
        for doc in resp.get("docs", []):
            if not doc.get("found"):
                continue
            src = doc.get("_source") or {}
            uid = src.get("object_uid") or doc.get("_id")
            # fix/enrich-labels-cascade-fallback: cascade through
            # canonical_name -> name -> primary_label instead of the
            # old single-field `name` lookup. Rescues legacy Korean
            # entities that only carry `primary_label` (or only
            # `name`) without needing a re-index sweep.
            label = _resolve_label(src)
            if uid and label:
                label_by_uid[uid] = label
            # fix/m32b-entity-type-degree-actual-wiring: pull `class`
            # alongside the label. `class` is the v0.2 entity classifier
            # output (person / organization / group / product / resource
            # / concept / knowledge / event / place) — exact match for
            # the FE ENTITY_COLORS keys in stellarColors.ts. We do NOT
            # gate on the label here because an unnamed-but-classified
            # doc should still drive node color.
            #
            # ★ REQ-014-D (PO 2026-07-02) — entity_type / class 동시 조회.
            #   REQ-012-v1 change_entity_type 는 두 필드 모두 갱신 (class 는
            #   legacy, entity_type 은 v3 표준). 하지만 legacy 문서 중에는
            #   entity_type 만 있거나 class 만 있는 경우가 혼재한다. class
            #   먼저 확인하고 없으면 entity_type 으로 폴백 → 새 규칙 (v3)
            #   과 옛 규칙 (v0.2) 문서 둘 다 정상 노출.
            entity_class = src.get("class") or src.get("entity_type")
            if uid and entity_class:
                entity_type_by_uid[uid] = entity_class
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("recall: label lookup failed: %s", exc)
        return facts

    out: list[RecallFact] = []
    for f in facts:
        subject_label = label_by_uid.get(f.subject_uid) if f.subject_uid else None
        object_label = (
            label_by_uid.get(f.object_value)
            if f.object_value and _is_entity_ref(f.object_value)
            else None
        )
        # fix/enrich-labels-cascade-fallback: speaker_label + parallel
        # array of related_entity_labels (index-aligned with
        # related_entity_uids so the FE can zip them). Missing entries
        # stay None — the FE renders "미해결 entity" for those.
        speaker_label = (
            label_by_uid.get(f.speaker_uid) if f.speaker_uid else None
        )
        related_entity_labels = [
            label_by_uid.get(ref_uid) for ref_uid in (f.related_entity_uids or [])
        ]
        # fix/m32b-entity-type-degree-actual-wiring: same shape as the
        # label resolution above — entity-type is only meaningful for
        # actual entity refs; literals leave the field as None.
        subject_entity_type = (
            entity_type_by_uid.get(f.subject_uid) if f.subject_uid else None
        )
        object_entity_type = (
            entity_type_by_uid.get(f.object_value)
            if f.object_value and _is_entity_ref(f.object_value)
            else None
        )
        # ★ REQ-014-D (PO 2026-07-02) — speaker_entity_type 회복.
        #   claim 화자 uid 도 mget 배치에 이미 포함되어 있으므로 별도 round-
        #   trip 없이 채울 수 있다. FE stellarRealAdapter 가 화자 노드를 만들
        #   때 이 값을 ensureEntity 에 넘겨서 노드 색·타입이 즉시 반영된다.
        speaker_entity_type = (
            entity_type_by_uid.get(f.speaker_uid) if f.speaker_uid else None
        )
        out.append(
            f.model_copy(update={
                "subject_label": subject_label,
                "object_label": object_label,
                "speaker_label": speaker_label,
                "related_entity_labels": related_entity_labels,
                "subject_entity_type": subject_entity_type,
                "object_entity_type": object_entity_type,
                "speaker_entity_type": speaker_entity_type,
            })
        )
    return out


def _resolve_entity_by_name(
    q: str, knowledge_space_id: str,
) -> dict[str, Any] | None:
    """Exact-name lookup (lowercased) over lucid_objects scoped to KS.
    Returns the matched object source dict or None."""
    if not q or not q.strip():
        return None
    q_norm = q.strip().lower()
    body = {
        "size": 1,
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                ],
                "should": [
                    {"term": {"name.keyword": q.strip()}},
                    {"term": {"name_en.keyword": q.strip()}},
                ],
                "minimum_should_match": 1,
            },
        },
    }
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS
        client = get_client()
        resp = client.search(index=LUCID_OBJECTS, body=body)
        hits = list(resp["hits"]["hits"])
        if not hits:
            # Fall back to lowercased keyword field; if the index
            # mapping doesn't have one we still attempt a wildcard.
            body["query"]["bool"]["should"] = [  # type: ignore[index]
                {"wildcard": {"name": f"*{q_norm}*"}},
                {"wildcard": {"name_en": f"*{q_norm}*"}},
            ]
            resp = client.search(index=LUCID_OBJECTS, body=body)
            hits = list(resp["hits"]["hits"])
        if not hits:
            return None
        return hits[0].get("_source") or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: entity-name lookup failed: %s", exc)
        return None


def _resolve_entities_by_name(
    q: str, knowledge_space_id: str, *, max_hits: int = 25,
) -> list[dict[str, Any]]:
    """Return EVERY entity in the KS whose name (or name_en) matches `q`.

    Ordered canonical UUID4 first, then everything else, so a brief
    representative pick (`[0]`) prefers the canonical document. The
    brief itself uses the WHOLE list (not just `[0]`) to find facts —
    that's the keystone of B-49b: when an old LLM-placeholder Object
    and a new canonical-UUID Object share a name (e.g. "SpaceX"), the
    facts attached to either side must surface together.
    """
    if not q or not q.strip():
        return []
    q_norm = q.strip().lower()
    q_stripped = q.strip()
    # B-52 — Korean ↔ English cross-language matching.
    # The decomposer normalizes some entities into English ("Ministry
    # of Defense") even when the source article is Korean. A user
    # then searching for "국방부" must still surface those facts.
    # Three-tier lookup:
    #   1. Exact-keyword on name / name_en / aliases — fastest path,
    #      survives even when the analyzer would chunk the term.
    #   2. Analyzed match across the same three fields — picks up
    #      partial / morpheme matches when the analyzer split tokens.
    #   3. Wildcard fallback for substring queries.
    body: dict[str, Any] = {
        "size": max_hits,
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                ],
                "should": [
                    {"term": {"name.keyword": q_stripped}},
                    {"term": {"name_en.keyword": q_stripped}},
                    {"term": {"aliases.keyword": q_stripped}},
                ],
                "minimum_should_match": 1,
            },
        },
    }
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS
        client = get_client()
        resp = client.search(index=LUCID_OBJECTS, body=body)
        hits = list(resp["hits"]["hits"])
        # Tier 2: analyzed match — covers tokenizer-driven splits the
        # exact term filter misses ("국방부" tokenized by nori).
        if not hits:
            body["query"]["bool"]["should"] = [  # type: ignore[index]
                {"multi_match": {
                    "query": q_stripped,
                    "fields": ["name", "name_en", "aliases"],
                    "type": "best_fields",
                }},
            ]
            resp = client.search(index=LUCID_OBJECTS, body=body)
            hits = list(resp["hits"]["hits"])
        # Tier 3: wildcard substring fallback (last resort).
        if not hits:
            body["query"]["bool"]["should"] = [  # type: ignore[index]
                {"wildcard": {"name": f"*{q_norm}*"}},
                {"wildcard": {"name_en": f"*{q_norm}*"}},
                {"wildcard": {"aliases.keyword": f"*{q_stripped}*"}},
            ]
            resp = client.search(index=LUCID_OBJECTS, body=body)
            hits = list(resp["hits"]["hits"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: multi-entity lookup failed: %s", exc)
        return []
    sources = [h.get("_source") or {} for h in hits]

    # Sort so canonical UUID4 uids land first. This is the same
    # `_UUID4_RE` the rest of the route uses to gate entity-link work.
    def _is_canonical(doc: dict[str, Any]) -> bool:
        uid = doc.get("object_uid") or ""
        return bool(_UUID4_RE.match(uid))

    sources.sort(key=lambda d: 0 if _is_canonical(d) else 1)
    return sources


def _facts_for_entity(
    entity_uids: str | list[str], knowledge_space_id: str, *, max_hits: int = 200,
) -> list[dict[str, Any]]:
    """Every manual fact in this KS where ANY of `entity_uids` sits on
    subject_uid or object_value. Single string accepted for backward
    compatibility with the pre-B-49b callers."""
    if isinstance(entity_uids, str):
        uids = [entity_uids]
    else:
        uids = list(entity_uids)
    if not uids:
        return []
    body: dict[str, Any] = {
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                    {"term": {"validation_method": "manual"}},
                    {"bool": {
                        "should": [
                            {"terms": {"subject_uid": uids}},
                            {"terms": {"object_value": uids}},
                        ],
                        "minimum_should_match": 1,
                    }},
                ],
            },
        },
        "size": max_hits,
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
        return list(resp["hits"]["hits"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: brief fact lookup failed: %s", exc)
        return []


def _facts_strictly_referencing_entity(
    entity_uids: list[str],
    knowledge_space_id: str,
    *,
    max_hits: int = 200,
    include_retracted: bool = False,
) -> list[dict[str, Any]]:
    """★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01).

    Return every manual fact in this KS where ANY of `entity_uids`
    appears in ANY of the entity-carrying slots on the ES doc:
      - subject_uid
      - object_value  (v3 canonical uid; may be a literal for non-entity objs)
      - speaker_uid   (v0.2 claim-layer speaker)
      - related_entity_uids  (m3-2a STELLAR v2 — claim-body referenced entities)

    This is the "entity 정확 매칭" fetch. HEARTH previously synthesized
    "A 는 B 와 함께 X" from an embedding hit that referenced B (not A),
    which is a cross-entity hallucination. The strict fetch is the
    guard: if the query resolves to A, only facts where A actually
    appears on one of the entity-carrying slots are returned. Cross-
    entity relations (co-mentions in claim bodies) come via
    `related_entity_uids`, which the extractor writes when an entity
    is *mentioned* inside a claim; the LLM can then answer about A
    without inventing relations that weren't stored.
    """
    if not entity_uids:
        return []
    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": knowledge_space_id}},
        {"term": {"validation_method": "manual"}},
        {"bool": {
            "should": [
                {"terms": {"subject_uid": entity_uids}},
                {"terms": {"object_value": entity_uids}},
                {"terms": {"speaker_uid": entity_uids}},
                {"terms": {"related_entity_uids": entity_uids}},
            ],
            "minimum_should_match": 1,
        }},
    ]
    retract = _retracted_clause(include_retracted)
    if retract is not None:
        filters.append(retract)
    body: dict[str, Any] = {
        "query": {"bool": {"filter": filters}},
        "size": max_hits,
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
        return list(resp["hits"]["hits"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: strict-entity fact lookup failed: %s", exc)
        return []


def _build_entity_brief(
    q: str, knowledge_space_id: str,
) -> EntityBrief | None:
    """Resolve `q` to every matching entity in the KS and group its facts.

    B-49b: when two Object documents share the same name (e.g. an old
    LLM-placeholder "SpaceX" and a B-35-canonical "SpaceX"), the brief
    must show facts attached to EITHER uid — that's what makes it
    agree with the facet panel + flat fact list, which already see
    both sides. The representative `entity_uid` on the response is the
    canonical-preferred pick so the UI labels make sense.
    """
    matches = _resolve_entities_by_name(q, knowledge_space_id)
    if not matches:
        return None

    # All uids that share this name. _resolve_entities_by_name has
    # already sorted canonical UUID4 first.
    entity_uids: list[str] = [
        m["object_uid"] for m in matches
        if isinstance(m.get("object_uid"), str)
    ]
    if not entity_uids:
        return None
    rep = matches[0]
    rep_uid = str(rep.get("object_uid") or entity_uids[0])
    entity_name = str(rep.get("name") or rep_uid)
    entity_class = rep.get("class")

    hits = _facts_for_entity(entity_uids, knowledge_space_id)
    if not hits:
        return EntityBrief(
            entity_uid=rep_uid,
            entity_name=entity_name,
            entity_class=entity_class,
            total_facts=0,
            as_subject=[],
            as_object=[],
        )

    # The set of "us" uids — any of these on subject or object means the
    # fact belongs to this brief.
    us = set(entity_uids)

    # Resolve labels for the OTHER side of each fact in one mget.
    other_uids: set[str] = set()
    for h in hits:
        src = h.get("_source") or {}
        if src.get("subject_uid") and src["subject_uid"] not in us:
            other_uids.add(src["subject_uid"])
        ov = src.get("object_value")
        if ov and ov not in us and _is_entity_ref(ov):
            other_uids.add(ov)
    label_by_uid: dict[str, str] = {}
    if other_uids:
        try:
            from api.storage.elasticsearch.client import LUCID_OBJECTS
            client = get_client()
            resp = client.mget(index=LUCID_OBJECTS, body={"ids": list(other_uids)})
            for d in resp.get("docs", []):
                if not d.get("found"):
                    continue
                s = d.get("_source") or {}
                uid = s.get("object_uid") or d.get("_id")
                if uid and s.get("name"):
                    label_by_uid[uid] = s["name"]
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall brief: label mget failed: %s", exc)

    subject_groups: dict[str, list[EntityFactRef]] = {}
    object_groups: dict[str, list[EntityFactRef]] = {}
    for h in hits:
        src = h.get("_source") or {}
        fact_uid = str(src.get("fact_uid") or h.get("_id") or "")
        claim = src.get("claim", "")
        predicate = src.get("predicate", "?")
        subj = src.get("subject_uid", "")
        obj = src.get("object_value", "")

        if subj in us:
            other = obj
            ref = EntityFactRef(
                fact_uid=fact_uid,
                claim=claim,
                predicate=predicate,
                other_uid=other,
                other_label=label_by_uid.get(other) if _is_entity_ref(other) else None,
            )
            subject_groups.setdefault(predicate, []).append(ref)
        elif obj in us:
            other = subj
            ref = EntityFactRef(
                fact_uid=fact_uid,
                claim=claim,
                predicate=predicate,
                other_uid=other,
                other_label=label_by_uid.get(other),
            )
            object_groups.setdefault(predicate, []).append(ref)

    return EntityBrief(
        entity_uid=rep_uid,
        entity_name=entity_name,
        entity_class=entity_class,
        total_facts=sum(len(v) for v in subject_groups.values())
        + sum(len(v) for v in object_groups.values()),
        as_subject=[
            EntityBriefGroup(predicate=p_, facts=fs)
            for p_, fs in sorted(subject_groups.items())
        ],
        as_object=[
            EntityBriefGroup(predicate=p_, facts=fs)
            for p_, fs in sorted(object_groups.items())
        ],
    )


# fix/recall-facet-bucket-expand (★ M-Dogfood ⑤⑪ root cause — PO 2026-06-30):
# 옛 3-bucket (organization / person / place) 시절엔 concept / resource /
# event / metric / knowledge / group / task / location 등이 전부 "other"
# 로 떨어져 "기타 비대" 가 됐다. v3 closed set 10 class 를 1:1 로 버킷
# 화해 "기타" 비대를 해소한다. legacy `place` 는 `location` 으로 호환
# alias (★ pre-v3 데이터). 알 수 없는 class 는 여전히 "other" fallback.
_OBJECT_CLASS_BUCKET = {
    # WHO
    "person": "person",
    "organization": "organization",
    "group": "group",
    # WHAT
    "knowledge": "knowledge",
    "resource": "resource",
    "task": "task",
    "concept": "concept",
    "event": "event",
    "metric": "metric",
    # WHERE
    "location": "location",
    # legacy alias (★ pre-v3 데이터 호환)
    "place": "location",
}


def _bucket_for(class_name: str | None) -> str:
    if not class_name:
        return "other"
    return _OBJECT_CLASS_BUCKET.get(class_name.lower(), "other")


def _bucket_for_unresolved(uid: str) -> str:
    """fix/recall-predicate-and-entity-type (PO 2026-06-26): a fallback
    bucket pick for entity references that did not resolve to a
    lucid_objects doc — typically a subject_uid still carrying the raw
    Korean surface ("한성숙") because the legacy capture never went
    through the entity-resolver. Without this guard the facet would
    classify every such name as "기타" (other), which the dogfood user
    correctly flagged as wrong for an obvious Korean person name.

    The heuristic itself lives in `entity_reclassifier` so the backfill
    tool and the live facet path agree on what "looks like a Korean
    person" means. Returns "other" for anything the heuristic cannot
    confidently classify — no LLM call, no surprise allocations.
    """
    if not uid or not isinstance(uid, str):
        return "other"
    # Skip canonical / placeholder uids — those resolve via lucid_objects
    # and we should never need this fallback for them.
    if _UUID4_RE.match(uid) or _OBJ_PLACEHOLDER_RE.match(uid):
        return "other"
    try:
        from api.structure.entity_reclassifier import classify_by_heuristic
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("recall: heuristic import failed: %s", exc)
        return "other"
    try:
        guess = classify_by_heuristic(uid)
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning(
            "recall: heuristic classify failed for %r: %s", uid, exc,
        )
        return "other"
    return _bucket_for(guess)


def _entity_type_of(src: dict[str, Any]) -> str | None:
    """feat/entity-layer-restore (PO 2026-06-23): prefer the canonical
    `entity_type` metadata field; fall back to legacy `class` for docs
    that predate the entity-layer restore. Returns None when neither
    field carries a usable string."""
    et = src.get("entity_type")
    if isinstance(et, str) and et.strip():
        return et
    cls = src.get("class")
    if isinstance(cls, str) and cls.strip():
        return cls
    return None


def _facets_for(
    fact_uids: list[str], knowledge_space_id: str, *, top_n: int = 25,
) -> RecallFacets:
    """Single ES aggregation pass over the CURRENT filtered fact set.

    Three terms aggs: subject_uid, object_value, predicate. The
    object_value bucket is post-filtered by the entity-ref regex so
    literals never leak into the facet panel. Entity names + classes
    come from a single mget against lucid_objects, keyed by the
    aggregated uids.
    """
    if not fact_uids:
        return RecallFacets()
    body: dict[str, Any] = {
        "size": 0,
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                    {"term": {"validation_method": "manual"}},
                    {"terms": {"fact_uid": fact_uids}},
                ],
            },
        },
        "aggs": {
            "subjects": {"terms": {"field": "subject_uid", "size": top_n}},
            "objects": {"terms": {"field": "object_value", "size": top_n}},
            "predicates": {"terms": {"field": "predicate", "size": top_n}},
            # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim
            # split bucket counts. `fact_type` is missing on legacy
            # docs; the terms agg skips them (FE FactCard treats null
            # as action so the count is the strict claim/action total).
            "fact_types": {"terms": {"field": "fact_type", "size": 5}},
        },
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: facet aggregation failed: %s", exc)
        return RecallFacets()

    aggs = resp.get("aggregations") or {}
    counts: dict[str, int] = {}
    for b in (aggs.get("subjects") or {}).get("buckets", []):
        key = b.get("key")
        if isinstance(key, str):
            counts[key] = counts.get(key, 0) + int(b.get("doc_count") or 0)
    for b in (aggs.get("objects") or {}).get("buckets", []):
        key = b.get("key")
        if isinstance(key, str) and _is_entity_ref(key):
            counts[key] = counts.get(key, 0) + int(b.get("doc_count") or 0)

    predicates_buckets = (aggs.get("predicates") or {}).get("buckets", [])
    predicates = [
        PredicateFacetItem(
            name=str(b.get("key") or ""), count=int(b.get("doc_count") or 0),
        )
        for b in predicates_buckets if b.get("key")
    ]

    # v0.2.0 step 1/2 — Action / Claim / Measurement bucket counts.
    # Bucket keys outside {'action', 'claim', 'measurement'} are
    # ignored — defensive guard against any future legacy values
    # landing in the index from out-of-band tooling.
    fact_type_buckets = (aggs.get("fact_types") or {}).get("buckets", [])
    ft_action = 0
    ft_claim = 0
    ft_measurement = 0
    for b in fact_type_buckets:
        key = b.get("key")
        doc_count = int(b.get("doc_count") or 0)
        if key == "action":
            ft_action += doc_count
        elif key == "claim":
            ft_claim += doc_count
        elif key == "measurement":
            ft_measurement += doc_count
    fact_types = FactTypeFacets(
        action=ft_action, claim=ft_claim, measurement=ft_measurement,
    )

    if not counts:
        return RecallFacets(predicates=predicates, fact_types=fact_types)

    # Single mget for entity {name, entity_type|class}. feat/entity-
    # layer-restore (PO 2026-06-23): prefer `entity_type`, fall back
    # to `class` so legacy docs (created before the entity-layer
    # restore) still bucket correctly.
    label_class: dict[str, tuple[str, str | None]] = {}
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS
        client = get_client()
        resp = client.mget(index=LUCID_OBJECTS, body={"ids": list(counts.keys())})
        for d in resp.get("docs", []):
            if not d.get("found"):
                continue
            src = d.get("_source") or {}
            uid = src.get("object_uid") or d.get("_id")
            if uid and src.get("name"):
                label_class[uid] = (src["name"], _entity_type_of(src))
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: facet label mget failed: %s", exc)

    # fix/recall-facet-bucket-expand (PO 2026-06-30) — v3 closed-set 10
    # bucket + "other" fallback. Aligned with _OBJECT_CLASS_BUCKET above
    # and EntityFacets schema in api/models/recall.py.
    buckets: dict[str, list[EntityFacetItem]] = {
        "person": [],
        "organization": [],
        "group": [],
        "knowledge": [],
        "resource": [],
        "task": [],
        "concept": [],
        "event": [],
        "metric": [],
        "location": [],
        "other": [],
    }
    for uid, c in counts.items():
        name, cls = label_class.get(uid, (uid, None))
        item = EntityFacetItem(uid=uid, name=name, count=c)
        # fix/recall-predicate-and-entity-type (PO 2026-06-26): when the
        # entity has no lucid_objects doc (legacy facts that store the
        # raw Korean surface as subject_uid because the resolver never
        # ran), fall back to a Korean-name heuristic so an obvious
        # person name does not drop into "기타". The heuristic is the
        # same one the backfill tool uses; the facet path always
        # degrades to "other" on heuristic failure.
        if cls is None and uid not in label_class:
            bucket = _bucket_for_unresolved(uid)
        else:
            bucket = _bucket_for(cls)
        buckets[bucket].append(item)
    for v in buckets.values():
        v.sort(key=lambda i: (-i.count, i.name.lower()))

    return RecallFacets(
        entities=EntityFacets(
            person=buckets["person"],
            organization=buckets["organization"],
            group=buckets["group"],
            knowledge=buckets["knowledge"],
            resource=buckets["resource"],
            task=buckets["task"],
            concept=buckets["concept"],
            event=buckets["event"],
            metric=buckets["metric"],
            location=buckets["location"],
            other=buckets["other"],
        ),
        predicates=predicates,
        fact_types=fact_types,
    )


@router.get("/recall", response_model=RecallResponse)
def recall(
    space_id: uuid.UUID,
    # ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 3) — entity-only scoped recall.
    # 옛: `q` required (min_length=1) → autocomplete pick (q='', entity=[uid])
    # 이 422 로 떨어졌다. fix: `q` optional. 둘 다 비면 _empty 로 단락,
    # 둘 중 하나만 있어도 정상 작동 (entity-only = "이 entity 의 모든
    # validated fact"; q-only = 기존 kNN search; 둘 다 = q kNN + entity AND filter).
    q: str = Query(default="", max_length=2000, description="Query"),
    limit: int = Query(default=RECALL_DEFAULT_K, ge=1, le=RECALL_MAX_K),
    entity: list[str] = Query(default_factory=list, alias="entity"),
    include_retracted: bool = Query(
        default=False,
        description="B-48a: surface facts with retracted_at set (default hides them)",
    ),
    score_threshold: float | None = Query(
        default=None, ge=0.0, le=1.0,
        description="B-50: override RECALL_SCORE_FLOOR (default 0.72)",
    ),
    date_from: datetime | None = Query(
        default=None, description="B-50: validated_at >= date_from",
    ),
    date_to: datetime | None = Query(
        default=None, description="B-50: validated_at <= date_to",
    ),
    user: User = Depends(get_current_user),
) -> RecallResponse:
    """Return validated facts whose embedding is close to `q`.

    Behaviour invariants (DR-089):
      - ONLY facts with `validation_method='manual'` are returned.
        Non-manual rows never reach the response, even if they exist in
        the index (enforced inside the ES kNN filter clause AND
        re-checked in the serialiser).
      - 0 hits — whether the index is empty, the query is irrelevant,
        or every hit is below the threshold — produces the same
        empty envelope. We do NOT generate, paraphrase, or augment.
      - Korean queries work first-class because the embedding model
        (OpenAI text-embedding-3-small) is multilingual.

    Refinements (all additive; default behaviour unchanged):
      - score_threshold (B-50): override RECALL_SCORE_FLOOR per call.
      - date_from / date_to (B-50): validated_at window, inclusive.
      - include_retracted (B-48a): surface soft-deleted facts.

    B-50-fix (PO directive 2026-06-18, A direction): the server NO
    LONGER honours a `match_kinds` query param. Embedding (kNN) is
    the search mode; entity-link expansion always runs after.
    `match_kind` lives as a display-side filter only — the client
    receives the full envelope and hides 🔍 / 🔗 rows in the UI.

    Failure-mode handling: any infrastructure error (no embedding API,
    ES down) returns the empty envelope rather than a 500. Recall must
    degrade quietly — surfacing nothing is correct under the
    zero-hallucination contract.
    """
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
    finally:
        session.close()

    # Defensive normalize: tests call this route directly without
    # FastAPI dependency resolution, so Query() sentinel objects can
    # leak in as defaults for list / bool params.
    include_retracted_bool = bool(include_retracted) if isinstance(
        include_retracted, bool,
    ) else False
    entity_uids_in: list[str] = entity if isinstance(entity, list) else []
    threshold = score_threshold if isinstance(
        score_threshold, (int, float),
    ) else RECALL_SCORE_FLOOR
    df = date_from if isinstance(date_from, datetime) else None
    dt = date_to if isinstance(date_to, datetime) else None

    # ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 3) — entity-only scoped recall.
    # autocomplete pick (RecallView.onPickSuggestion) 은 q='' 로 entity uid
    # 만 보낸다. kNN 은 q 가 비면 embedding 을 못 만들어 _empty 가 되지만,
    # entity 가 있으면 그 entity 의 ALL validated facts 를 돌려주는 게
    # 사용자 의도다. q + entity 둘 다 비면 기존처럼 empty.
    q_norm = (q or "").strip()
    if not q_norm and not entity_uids_in:
        return _empty("no_query")

    facts: list[RecallFact] = []
    # ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01).
    # When True we entered the strict entity-match path — either via an
    # explicit `entity=` autocomplete pick, or via a confident entity-name
    # resolution of `q`. In strict mode we return ONLY facts referencing
    # the entity on entity-carrying slots (no kNN, no cross-entity graph
    # expansion). If the strict path yields zero facts we fall back to
    # similarity kNN and tag those `similarity_fallback` for the amber FE
    # badge. See RecallFact.match_kind doc.
    strict_entity_mode = False
    strict_entity_yielded_zero = False

    if not q_norm and entity_uids_in:
        # entity-only path — 명시적 autocomplete pick. 이 자체가 strict
        # entity 매칭이다: kNN 없이 entity 참조 fact 만 반환.
        strict_entity_mode = True
        try:
            seed_hits = _facts_strictly_referencing_entity(
                list(entity_uids_in), str(ks.id),
                max_hits=limit * 3,
                include_retracted=include_retracted_bool,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall: entity-only fetch failed: %s", exc)
            seed_hits = []
        for h in seed_hits:
            fact = _hit_to_fact(h)
            if fact is not None:
                facts.append(
                    fact.model_copy(update={"match_kind": "entity_direct"})
                )
        if not facts:
            strict_entity_yielded_zero = True
    else:
        # ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01).
        # Attempt entity 정확 매칭 BEFORE embedding kNN. If `q` names a
        # known entity in this KS (confident bigram Jaccard >= 0.6, same
        # gate as the existing name-fallback), the strict path returns
        # ONLY facts referencing that entity_uid on entity-carrying slots.
        # No kNN, no cross-entity expansion — that's the hallucination
        # guard: HEARTH cannot synthesize "A 는 B 와 함께" from a fact
        # that mentions B (not A). When strict yields zero we fall back
        # to similarity kNN below and tag those `similarity_fallback`.
        resolved_entity_uids: list[str] = []
        try:
            _q_matches = _resolve_entities_by_name(q_norm, str(ks.id))
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall: entity resolve for strict path failed: %s", exc)
            _q_matches = []

        def _resolve_is_confident(doc: dict[str, Any]) -> bool:
            candidates: list[str] = []
            for _k in ("name", "name_en"):
                _v = doc.get(_k)
                if isinstance(_v, str) and _v.strip():
                    candidates.append(_v)
            aliases = doc.get("aliases")
            if isinstance(aliases, list):
                candidates.extend(
                    a for a in aliases if isinstance(a, str) and a.strip()
                )
            return any(
                _entity_match_is_confident(q_norm, name) for name in candidates
            )

        confident_q_matches = [d for d in _q_matches if _resolve_is_confident(d)]
        resolved_entity_uids = [
            uid for uid in (
                doc.get("object_uid") for doc in confident_q_matches
            )
            if isinstance(uid, str)
        ]
        if resolved_entity_uids:
            strict_entity_mode = True
            try:
                strict_hits = _facts_strictly_referencing_entity(
                    resolved_entity_uids, str(ks.id),
                    max_hits=limit * 3,
                    include_retracted=include_retracted_bool,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "recall: strict entity fetch failed: %s", exc,
                )
                strict_hits = []
            for h in strict_hits:
                fact = _hit_to_fact(h)
                if fact is None:
                    continue
                # ★ AND-intersect with any explicit entity= filter (B-49).
                if entity_uids_in:
                    src = h.get("_source") or {}
                    ok = all(
                        (
                            src.get("subject_uid") == uid
                            or src.get("object_value") == uid
                            or src.get("speaker_uid") == uid
                            or uid in (src.get("related_entity_uids") or [])
                        )
                        for uid in entity_uids_in
                    )
                    if not ok:
                        continue
                facts.append(
                    fact.model_copy(update={"match_kind": "entity_direct"})
                )
            if not facts:
                strict_entity_yielded_zero = True

        if not strict_entity_mode:
            # 옛 embedding path — q 가 entity 로 해석되지 않을 때만.
            embedding = get_embedding(q_norm)
            if embedding is None:
                return _empty("embedding_unavailable")

            try:
                hits = _knn_facts_validated_only(
                    list(embedding), str(ks.id), limit,
                    entity_filter_uids=list(entity_uids_in),
                    include_retracted=include_retracted_bool,
                    date_from=df,
                    date_to=dt,
                )
            except Exception as exc:  # noqa: BLE001 - degrade quietly
                logger.warning("recall: ES kNN failed: %s", exc)
                return _empty("es_unavailable")

            for hit in hits:
                score = float(hit.get("_score") or 0.0)
                if score < threshold:
                    # Hits are sorted by score desc; first below-floor → stop.
                    break
                fact = _hit_to_fact(hit)
                if fact is not None:
                    facts.append(fact)

    # B-45-fix3: if no fact survives the kNN floor, try the entity
    # name path. Korean-text image facts often fail cross-lingual kNN
    # against an English query (or marginal-score in-language hits
    # sit at 0.71 just below the 0.72 floor). The entity lookup
    # honours name + name_en + aliases — the same path B-49b's brief
    # uses — so a query that resolves to a known entity surfaces ALL
    # of that entity's manual facts. The kNN match_kind label stays
    # "embedding" so the UI still shows a 🔍 badge; users see the
    # facts they searched for rather than an empty envelope.
    #
    # ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01):
    # skip this fallback when we're in strict-entity mode. In strict mode
    # the entity resolved but yielded 0 facts — we want the similarity kNN
    # fallback right below, NOT another entity-scoped fetch (which would
    # loop back and return 0 again).
    entity_seed_uids: list[str] = []
    if not facts and not strict_entity_mode:
        try:
            matched_entities = _resolve_entities_by_name(q, str(ks.id))
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall: name-lookup fallback failed: %s", exc)
            matched_entities = []
        # search-embedding-restore (v0.2.0 graduation gate): filter
        # entity-name candidates by bigram Jaccard against the query so
        # the wildcard substring fallback can't surface unrelated
        # entities that merely share a token (PO repro: 선거관리위원회 →
        # 최저임금위원회 share only the "위원회" tail). Jaccard 0.6 cleanly
        # separates the repro pair (0.20) from a real self-match (1.0)
        # and from a real prefix overlap like 선거관리위원장 (~0.71).
        #
        # Confidence is the MAX Jaccard across the entity's name fields —
        # name / name_en / aliases — so a Korean query against an entity
        # whose canonical name is English (B-52 cross-lingual: "Ministry
        # of Defense" matched by 국방부 alias) still confidently surfaces.
        def _doc_is_confident(doc: dict[str, Any]) -> bool:
            candidates: list[str] = []
            for k in ("name", "name_en"):
                v = doc.get(k)
                if isinstance(v, str) and v.strip():
                    candidates.append(v)
            aliases = doc.get("aliases")
            if isinstance(aliases, list):
                candidates.extend(a for a in aliases if isinstance(a, str) and a.strip())
            return any(_entity_match_is_confident(q, name) for name in candidates)

        confident_entities = [
            doc for doc in matched_entities if _doc_is_confident(doc)
        ]
        if matched_entities and not confident_entities:
            logger.info(
                "recall: entity-name fallback rejected %d low-confidence "
                "matches for query %r",
                len(matched_entities), q,
            )
        entity_seed_uids = [
            uid for uid in (doc.get("object_uid") for doc in confident_entities)
            if isinstance(uid, str)
        ]
        if entity_seed_uids:
            try:
                seed_hits = _facts_for_entity(
                    entity_seed_uids, str(ks.id), max_hits=limit * 3,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "recall: name-lookup fact fetch failed: %s", exc,
                )
                seed_hits = []
            for h in seed_hits:
                fact = _hit_to_fact(h)
                if fact is not None:
                    facts.append(fact)

    # ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01):
    # strict entity mode found the entity but 0 direct facts → fall back
    # to similarity kNN so the user sees SOMETHING (with an amber "유사
    # 참고" badge on every card). Skip when q was empty (entity-only pick
    # with no facts: return the empty envelope — the user picked a real
    # entity that just has no facts yet).
    if (
        not facts
        and strict_entity_mode
        and strict_entity_yielded_zero
        and q_norm
    ):
        try:
            fallback_embedding = get_embedding(q_norm)
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall: fallback embedding failed: %s", exc)
            fallback_embedding = None
        if fallback_embedding is not None:
            try:
                fallback_hits = _knn_facts_validated_only(
                    list(fallback_embedding), str(ks.id), limit,
                    include_retracted=include_retracted_bool,
                    date_from=df,
                    date_to=dt,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("recall: fallback kNN failed: %s", exc)
                fallback_hits = []
            for hit in fallback_hits:
                score = float(hit.get("_score") or 0.0)
                if score < threshold:
                    break
                fact = _hit_to_fact(hit)
                if fact is not None:
                    facts.append(
                        fact.model_copy(
                            update={"match_kind": "similarity_fallback"},
                        )
                    )

    if not facts:
        return _empty("no_facts_above_floor")

    # B-25 stage 2 / B-35 wiring: surface every other validated fact
    # in this knowledge_space that references any of the same
    # canonical Object uids. This is the graph join PO asked for —
    # "SpaceX 검색 -> SpaceX 가 subject 든 object 든 등장하는 fact 전부".
    # B-50-fix: always runs — the client filters 🔗 rows on display
    # if the user wants to hide them.
    #
    # ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01):
    # SKIP the cross-entity graph expansion when we're in strict entity
    # mode. The whole point of strict mode is to prevent HEARTH from
    # synthesizing "A 는 B 와 함께" when the recall carried a B-referencing
    # fact via graph-neighbour expansion. Only run the expansion for
    # the legacy embedding path where the query did not resolve to
    # an entity.
    expansion_count = 0
    if not strict_entity_mode:
        link_hits: list[dict[str, Any]] = []
        entity_uids = _collect_entity_uids(facts)
        already = {f.fact_uid for f in facts}
        try:
            link_hits = _entity_link_facts(
                entity_uids, str(ks.id),
                exclude_fact_uids=already,
                max_hits=max(RECALL_MAX_K, limit * 5),
                include_retracted=include_retracted_bool,
                date_from=df,
                date_to=dt,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall: entity-link expansion failed: %s", exc)
            link_hits = []
        for hit in link_hits:
            fact = _hit_to_fact(hit)
            if fact is None:
                continue
            # B-49: entity filter is AND. Drop expanded facts that don't
            # reference every active filter uid.
            if entity_uids_in:
                src = hit.get("_source") or {}
                ok = all(
                    src.get("subject_uid") == uid or src.get("object_value") == uid
                    for uid in entity_uids_in
                )
                if not ok:
                    continue
            fact = fact.model_copy(update={"match_kind": "entity_link"})
            facts.append(fact)
            expansion_count += 1

    facts = _enrich_with_labels(facts, str(ks.id))

    # B-41 P1: entity brief. Quietly returns None when q doesn't match
    # a known entity — RecallView falls back to the flat fact list.
    try:
        brief = _build_entity_brief(q, str(ks.id))
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: brief synthesis failed: %s", exc)
        brief = None

    facets = _facets_for([f.fact_uid for f in facts], str(ks.id))

    # feat/fact-contradiction-detection-v1 (v0.2.0 step 3): bulk-load
    # contradiction counts for the visible page in a single Postgres
    # query and project onto each RecallFact. Degrades quietly — if the
    # query fails, contradiction_count stays 0 and the FE shows no badge.
    facts = _project_contradiction_counts(facts)

    return RecallResponse(
        signature=SIGNATURE_HIT_TEMPLATE.format(n=len(facts)),
        facts=facts,
        total=len(facts),
        expanded_count=expansion_count,
        entity_brief=brief,
        facets=facets,
    )


def _project_contradiction_counts(facts: list[RecallFact]) -> list[RecallFact]:
    """Bulk-load CONTRADICTS edges for the page and project onto each
    RecallFact. One Postgres query regardless of page size."""
    if not facts:
        return facts
    try:
        from api.structure.contradiction_detector import (
            count_contradictions_for_facts,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: contradiction detector import failed: %s", exc)
        return facts

    session = _new_session()
    try:
        counts = count_contradictions_for_facts(
            session, [f.fact_uid for f in facts],
        )
    except Exception as exc:  # noqa: BLE001 — degrade quietly
        logger.warning("recall: contradiction count lookup failed: %s", exc)
        return facts
    finally:
        session.close()

    if not counts:
        return facts
    return [
        f.model_copy(update={"contradiction_count": counts.get(f.fact_uid, 0)})
        for f in facts
    ]


# ---------------------------------------------------------------------------
# B-48b — fact detail + retract / restore / detach-source
# ---------------------------------------------------------------------------

def _resolve_object_for_detail(
    uid: str, knowledge_space_id: str, role: str,
) -> FactDetailEntity | None:
    """Fetch one Object doc and project it into a FactDetailEntity.
    Returns None when the uid doesn't resolve — the panel falls back
    to showing the raw value in that case."""
    from api.storage.elasticsearch.client import LUCID_OBJECTS
    client = get_client()
    try:
        if not client.exists(index=LUCID_OBJECTS, id=uid):
            return None
        doc = client.get(index=LUCID_OBJECTS, id=uid)["_source"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("fact-detail: object lookup failed for %s: %s", uid, exc)
        return None
    if doc.get("knowledge_space_id") != knowledge_space_id:
        return None
    aliases_raw = doc.get("aliases") or []
    return FactDetailEntity(
        uid=uid,
        name=doc.get("name") or uid,
        name_en=doc.get("name_en"),
        **{"class": doc.get("class")},
        role=role,  # type: ignore[arg-type]
        aliases=list(aliases_raw) if isinstance(aliases_raw, list) else [],
    )


def _resolve_sources_for_detail(
    source_uids: list[str], knowledge_space_id: str,
) -> list[FactDetailSource]:
    """Walk the lucid_sources index for each source_uid and the
    Postgres source_jobs table for snapshot availability. Order
    follows the fact's source_uids list so the UI's "이 출처만 떼기"
    rows stay stable across re-renders."""
    if not source_uids:
        return []
    from api.storage.elasticsearch.client import LUCID_SOURCES
    client = get_client()
    out: list[FactDetailSource] = []
    snapshot_check_jobs: list[tuple[int, str]] = []
    for idx, suid in enumerate(source_uids):
        try:
            if not client.exists(index=LUCID_SOURCES, id=suid):
                continue
            doc = client.get(index=LUCID_SOURCES, id=suid)["_source"]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "fact-detail: source lookup failed for %s: %s", suid, exc,
            )
            continue
        if doc.get("knowledge_space_id") != knowledge_space_id:
            continue
        job_id = doc.get("source_job_id")
        out.append(FactDetailSource(
            source_uid=suid,
            source_job_id=job_id,
            url=doc.get("url") or "",
            domain=doc.get("domain"),
            captured_at=doc.get("captured_at"),
            source_type=doc.get("source_type"),
            author=doc.get("author"),
            title=doc.get("title"),
            snapshot_available=False,
        ))
        if job_id:
            snapshot_check_jobs.append((idx, job_id))
    # One DB round-trip to check which source_jobs still carry the
    # raw_payload bytes (snapshot view in B-48b/Phase-2).
    if snapshot_check_jobs:
        from api.storage.postgres.orm import SourceJobORM
        session = _new_session()
        try:
            for _idx, job_id in snapshot_check_jobs:
                try:
                    job_uuid = uuid.UUID(job_id)
                except (TypeError, ValueError):
                    continue
                job = session.get(SourceJobORM, job_uuid)
                if job is not None and job.raw_payload:
                    # `out` is indexed in the same order as input so
                    # this lookup stays cheap.
                    out_idx = next(
                        (i for i, s in enumerate(out)
                         if s.source_job_id == job_id), None,
                    )
                    if out_idx is not None:
                        out[out_idx] = out[out_idx].model_copy(
                            update={"snapshot_available": True},
                        )
        finally:
            session.close()
    return out


def _build_fact_detail(
    fact_uid: str, knowledge_space_id: str,
) -> FactDetailResponse | None:
    """Read one fact + its referenced entities + its sources."""
    fact_doc = get_fact_by_uid(fact_uid)
    if fact_doc is None:
        return None
    if fact_doc.get("knowledge_space_id") != knowledge_space_id:
        return None

    # Subject is always an entity ref; object_value is sometimes a
    # literal — only resolve the object when it shapes like a uid.
    subject_entity = _resolve_object_for_detail(
        fact_doc["subject_uid"], knowledge_space_id, role="subject",
    )
    object_value = fact_doc.get("object_value") or ""
    object_entity = None
    if _is_entity_ref(object_value):
        object_entity = _resolve_object_for_detail(
            object_value, knowledge_space_id, role="object",
        )
    entities: list[FactDetailEntity] = [
        e for e in (subject_entity, object_entity) if e is not None
    ]

    sources = _resolve_sources_for_detail(
        list(fact_doc.get("source_uids") or []), knowledge_space_id,
    )

    header = FactDetailHeader(
        fact_uid=fact_doc["fact_uid"],
        claim=fact_doc["claim"],
        claim_en=fact_doc.get("claim_en"),
        subject_uid=fact_doc["subject_uid"],
        subject_label=subject_entity.name if subject_entity else None,
        predicate=fact_doc["predicate"],
        # fix/recall-predicate-and-entity-type (PO 2026-06-26): pass the
        # server-resolved predicate gloss through so the modal renders
        # the same label as the recall card. Legacy docs without the
        # field stay None and the frontend helper falls back to the
        # canonical predicate surface.
        predicate_label=fact_doc.get("predicate_label"),
        object_value=object_value,
        object_label=object_entity.name if object_entity else None,
        validated_at=fact_doc["validated_at"],
        retracted_at=fact_doc.get("retracted_at"),
        retracted_by=fact_doc.get("retracted_by"),
        edit_history=list(fact_doc.get("edit_history") or []),
        # fact-display-unification — pass through the fact_type layer
        # fields the Recall list already exposes via RecallFact so the
        # detail modal can render the same [CLAIM]/[MEASUREMENT] badge
        # + per-type strip. Legacy docs leave each field None and the
        # frontend FactTypeBadge/FactTypeStrip early-return.
        fact_type=fact_doc.get("fact_type"),
        speaker_label=fact_doc.get("speaker_label"),
        speech_act=fact_doc.get("speech_act"),
        content_claim=fact_doc.get("content_claim"),
        metric=fact_doc.get("metric"),
        measurement_value=fact_doc.get("measurement_value"),
        measurement_unit=fact_doc.get("measurement_unit"),
        as_of=fact_doc.get("as_of"),
    )

    return FactDetailResponse(fact=header, entities=entities, sources=sources)


@router.get(
    "/facts/{fact_uid}",
    response_model=FactDetailResponse,
)
def fact_detail(
    space_id: uuid.UUID,
    fact_uid: str,
    user: User = Depends(get_current_user),
) -> FactDetailResponse:
    """B-48b: full fact detail for the right-panel swap."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()
    detail = _build_fact_detail(fact_uid, str(space_id))
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )
    return detail


# ---------------------------------------------------------------------------
# feat/fact-detail-modify — PO directive 2026-06-22.
#
# PO wants the Recall Fact-detail modal to be EDITABLE — same affordance
# as Decide's edit mode, but limited to surface fields. Identity stays
# immutable (subject_uid / fact_type / predicate / validation_method);
# the user-visible chrome (claim / predicate_label / object_value /
# tags) can be corrected in-place. Structural changes still require a
# retract + new-fact flow.
#
# feat/stage3-predicate-code-fact-type (2026-06-28): predicate_code is
# now legacy after the STAGE 3 격하 and no longer participates in fact
# identity — the dedup key is (subject_uid, fact_type, predicate as
# natural-language surface, validation_method). predicate_code stays
# nullable on the ES doc for backfill safety but it is not part of
# identity.
#
# The endpoint is PATCH (idempotent semantics — a re-PATCH with the
# same body is a no-op against ES because `update_fact` recomputes
# embedding only when the claim text changed). The mutation goes
# through `update_fact`, which already appends the prior claim to
# `aliases` and writes an `edit_history` row so the audit trail is
# preserved automatically.
# ---------------------------------------------------------------------------

_MODIFIABLE_FIELDS: frozenset[str] = frozenset({
    "claim", "predicate_label", "object_value", "tags",
})


@router.patch(
    "/facts/{fact_uid}",
    response_model=FactDetailResponse,
)
def modify_fact(
    space_id: uuid.UUID,
    fact_uid: str,
    body: ModifyFactRequest,
    user: User = Depends(get_current_user),
) -> FactDetailResponse:
    """Modify a validated fact's surface fields.

    Editable: claim, predicate_label, object_value, tags. Identity
    fields (subject_uid, fact_type, predicate, validation_method,
    validator_id) are NEVER changed by this endpoint — a structural
    change goes through retract + re-validate. predicate_code is
    legacy after feat/stage3-predicate-code-fact-type and no longer
    participates in fact identity.

    400 when no editable fields are present (empty patch).
    404 when the fact does not exist OR belongs to a different KS.
    403 when the KS belongs to a different user.

    Audit trail: claim changes propagate through the existing
    `update_fact` helper, which appends the prior claim to the
    `aliases` list AND writes an `edit_history` row. Other fields
    (predicate_label / object_value / tags) update in place — they
    do NOT generate an `edit_history` entry because the surface-only
    edit is a typo-fix affordance, not a semantic claim revision.
    The PO accepted this trade-off (per directive).
    """
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()

    fact_doc = get_fact_by_uid(fact_uid)
    if fact_doc is None or fact_doc.get("knowledge_space_id") != str(space_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )

    # model_dump(exclude_unset=True) so we only see fields the client
    # actually set — a None value the client explicitly sent (e.g.
    # "clear the predicate_label") is preserved, while a field the
    # client omitted is left alone.
    payload = body.model_dump(exclude_unset=True)
    # Filter to the allow-list; ignore (don't 400) on unknown keys so
    # forward-compat clients can send fields newer servers understand.
    updates = {k: v for k, v in payload.items() if k in _MODIFIABLE_FIELDS}
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="no_modifiable_fields",
        )

    # Skip the storage call entirely if nothing actually changed —
    # the request was a no-op (same value re-sent). This is friendly
    # to optimistic clients that re-PATCH on every edit-mode close.
    changed = {
        k: v for k, v in updates.items()
        if fact_doc.get(k) != v
    }
    if changed:
        from api.storage.elasticsearch.facts import update_fact as _update_fact
        try:
            _update_fact(fact_uid, changed, editor_uid=str(user.id))
        except ValueError:
            # update_fact raises ValueError when the fact disappears
            # between our get + write — racing edit. Surface as 404.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="fact_not_found",
            )

    # Return the refreshed detail so the client can swap state in one
    # round-trip (no second GET needed).
    detail = _build_fact_detail(fact_uid, str(space_id))
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )
    return detail


def _record_retract_audit(
    user_id: uuid.UUID,
    fact_uid: str,
    action: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Log retract / restore / detach_source into validation_logs.
    Quiet failure — the mutation has already succeeded in ES, so a
    DB hiccup here shouldn't 500 the user."""
    from api.metrics.precision import record_validation_decision
    session = _new_session()
    try:
        record_validation_decision(
            session,
            user_id=user_id, validator_id=user_id,
            source_job_id=None,
            fact_uid=fact_uid,
            object_uid=None,
            action=action,  # type: ignore[arg-type]
            decision_metadata=metadata,
        )
        session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit: %s for %s failed: %s", action, fact_uid, exc)
    finally:
        session.close()


def _set_retracted(
    fact_uid: str, retracted_at_iso: str | None, retracted_by: str | None,
) -> None:
    """Partial-update a FactNode's retract fields in lucid_facts."""
    client = get_client()
    if not client.exists(index=LUCID_FACTS, id=fact_uid):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )
    doc: dict[str, Any] = {
        "retracted_at": retracted_at_iso,
        "retracted_by": retracted_by,
    }
    client.update(
        index=LUCID_FACTS, id=fact_uid, doc=doc, refresh="wait_for",
    )


@router.post(
    "/facts/{fact_uid}/retract",
    response_model=FactMutationResponse,
)
def retract_fact(
    space_id: uuid.UUID,
    fact_uid: str,
    user: User = Depends(get_current_user),
) -> FactMutationResponse:
    """B-48b ★ soft-delete a fact. Recall hides it by default; a
    later restore call reverts. The retracted_at stamp goes onto
    `lucid_facts` and an audit row lands in validation_logs."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()

    fact_doc = get_fact_by_uid(fact_uid)
    if fact_doc is None or fact_doc.get("knowledge_space_id") != str(space_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )
    from datetime import UTC
    from datetime import datetime as _dt
    now_dt = _dt.now(UTC)
    _set_retracted(fact_uid, now_dt.isoformat(), str(user.id))
    _record_retract_audit(user.id, fact_uid, "retract")
    return FactMutationResponse(
        fact_uid=fact_uid,
        retracted_at=now_dt,
        source_uids=list(fact_doc.get("source_uids") or []),
        auto_retracted=False,
    )


@router.post(
    "/facts/{fact_uid}/restore",
    response_model=FactMutationResponse,
)
def restore_fact(
    space_id: uuid.UUID,
    fact_uid: str,
    user: User = Depends(get_current_user),
) -> FactMutationResponse:
    """B-48b ★ undo a retract by clearing retracted_at / retracted_by."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()

    fact_doc = get_fact_by_uid(fact_uid)
    if fact_doc is None or fact_doc.get("knowledge_space_id") != str(space_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )
    _set_retracted(fact_uid, None, None)
    _record_retract_audit(user.id, fact_uid, "restore")
    return FactMutationResponse(
        fact_uid=fact_uid,
        retracted_at=None,
        source_uids=list(fact_doc.get("source_uids") or []),
        auto_retracted=False,
    )


@router.post(
    "/facts/{fact_uid}/detach-source",
    response_model=FactMutationResponse,
)
def detach_source(
    space_id: uuid.UUID,
    fact_uid: str,
    req: DetachSourceRequest,
    user: User = Depends(get_current_user),
) -> FactMutationResponse:
    """B-48b ★ remove one source from a fact's source_uids.

    PO directive 2026-06-18 [B-48 decision 2]: when the LAST source
    is detached, the fact has nothing left to back it up — auto
    retract so the recall surface stays honest. Restore brings it
    back; the source can be re-attached on the next capture."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()

    fact_doc = get_fact_by_uid(fact_uid)
    if fact_doc is None or fact_doc.get("knowledge_space_id") != str(space_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="fact_not_found",
        )
    current = list(fact_doc.get("source_uids") or [])
    if req.source_uid not in current:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="source_not_attached_to_fact",
        )
    next_sources = [s for s in current if s != req.source_uid]
    client = get_client()
    update_doc: dict[str, Any] = {"source_uids": next_sources}
    auto_retracted = False
    # Pass-through the existing retracted_at (string from ES) — the
    # Pydantic model will coerce it to datetime on response.
    retracted_at_out: Any = fact_doc.get("retracted_at")
    if not next_sources and not fact_doc.get("retracted_at"):
        from datetime import UTC
        from datetime import datetime as _dt
        now_dt = _dt.now(UTC)
        retracted_at_out = now_dt
        update_doc["retracted_at"] = now_dt.isoformat()
        update_doc["retracted_by"] = str(user.id)
        auto_retracted = True
    client.update(
        index=LUCID_FACTS, id=fact_uid, doc=update_doc, refresh="wait_for",
    )

    _record_retract_audit(
        user.id, fact_uid, "detach_source",
        metadata={
            "source_uid": req.source_uid,
            "auto_retracted": auto_retracted,
        },
    )

    return FactMutationResponse(
        fact_uid=fact_uid,
        retracted_at=retracted_at_out,
        source_uids=next_sources,
        auto_retracted=auto_retracted,
    )


# ---------------------------------------------------------------------------
# B-62 — facts listing for Stellar real-mode.
#
# The recall endpoint is semantic + keyword-scored, and DR-089 forbids
# the empty q. That left the Stellar real adapter doing keyword fishing
# with 5 generic seed queries (사실 / 분석 / 보고서 / 발표 / 체결) which
# could only surface facts whose text happened to match. PO repro:
# SpaceX facts NEVER appeared in real-mode because none of the seed
# queries hit them.
#
# This endpoint is intent-separated: recall is for "find me facts about
# X"; facts is for "give me the whole graph slice". Plain `match_all`
# + filter (KS + manual) + sort validated_at desc. Capped at 500 server-
# side so a runaway client can not pull a 100k-fact KS into memory.
# ---------------------------------------------------------------------------

FACTS_DEFAULT_LIMIT = 200
FACTS_MAX_LIMIT = 500


@router.get("/facts", response_model=FactsList)
def list_space_facts(
    space_id: uuid.UUID,
    limit: int = Query(
        default=FACTS_DEFAULT_LIMIT,
        ge=1,
        le=FACTS_MAX_LIMIT,
        description="Maximum facts to return. Hard-capped server-side.",
    ),
    user: User = Depends(get_current_user),
) -> FactsList:
    """All validated facts in one KS, sorted newest first.

    Resolution: same auth pattern as `recall` — 404 on unknown space,
    403 when not owned by the caller.

    Query: `match_all` inside an ES `bool.filter` so the response is
    deterministic and the score is not consulted (no kNN, no semantic
    weighting). The filter pins `knowledge_space_id` + `validation_method
    = manual` so the response can never leak auto-validated rows or
    rows from another KS.

    Fail-soft: if ES throws, the endpoint returns an empty `FactsList`
    rather than 500. Auth/space errors stay as 401/403/404.
    """
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()
    ks_id = str(space_id)

    body: dict[str, Any] = {
        "size": limit,
        "sort": [{"validated_at": {"order": "desc"}}],
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": ks_id}},
                    {"term": {"validation_method": "manual"}},
                ],
                # Exclude soft-deleted (retracted) facts so the
                # visualisation does not show ghosts.
                "must_not": [
                    {"exists": {"field": "retracted_at"}},
                ],
            },
        },
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("facts: ES search failed: %s", exc)
        return FactsList(facts=[], total=0, truncated=False)

    hits = list(resp.get("hits", {}).get("hits") or [])
    facts: list[RecallFact] = []
    for hit in hits:
        fact = _hit_to_fact(hit)
        if fact is not None:
            facts.append(fact)

    facts = _enrich_with_labels(facts, ks_id)

    # `hits.total` carries the true count (across all matches), not
    # just the bounded `size` page. ES returns it as either an int
    # (older shapes) or a dict with `value`.
    total_raw = (resp.get("hits") or {}).get("total")
    if isinstance(total_raw, dict):
        total_int = int(total_raw.get("value") or 0)
    else:
        total_int = int(total_raw or 0)

    return FactsList(
        facts=facts,
        total=len(facts),
        truncated=total_int > len(facts),
    )


# ---------------------------------------------------------------------------
# feat/ledger-view — LEDGER (제3의 뷰).
#
# Chronological list of recently validated facts in one KS, sorted by
# validated_at desc with _id as secondary tie-break. Paged with
# limit (default 20, max 100) + offset. Optional fact_type chip
# filter narrows to action / claim / measurement. The destination for
# HEARTH "기록 보기" and the weekly briefing's "이번주 검증" link.
#
# Intent-separated from RECALL (no embedding, no kNN, no score floor)
# and from FACTS (which is unpaginated; capped at 500). LEDGER is
# explicit pagination so the chrome stays responsive on a big KS.
# ---------------------------------------------------------------------------

LEDGER_DEFAULT_LIMIT = 20
LEDGER_MAX_LIMIT = 100


def _project_to_ledger_item(fact: RecallFact) -> LedgerItem:
    """Project a label-enriched RecallFact to the LEDGER surface.

    Drops score / match_kind / contradiction_count / validator_id /
    validation_method / negation_* / stance — the ledger surface
    doesn't need them. Keeps the type-layer fields the shared
    FactTypeBadge / FactTypeStrip consume so the [CLAIM] /
    [MEASUREMENT] visual parity with RECALL is preserved.
    """
    return LedgerItem(
        fact_uid=fact.fact_uid,
        claim=fact.claim,
        claim_en=fact.claim_en,
        subject_uid=fact.subject_uid,
        subject_label=fact.subject_label,
        predicate=fact.predicate,
        predicate_label=fact.predicate_label,
        object_value=fact.object_value,
        object_label=fact.object_label,
        source_uids=list(fact.source_uids),
        validated_at=fact.validated_at,
        knowledge_space_id=fact.knowledge_space_id,
        fact_type=fact.fact_type,
        speaker_label=fact.speaker_label,
        speech_act=fact.speech_act,
        content_claim=fact.content_claim,
        metric=fact.metric,
        measurement_value=fact.measurement_value,
        measurement_unit=fact.measurement_unit,
        as_of=fact.as_of,
    )


@router.get("/ledger", response_model=LedgerResponse)
def list_ledger(
    space_id: uuid.UUID,
    limit: int = Query(
        default=LEDGER_DEFAULT_LIMIT,
        ge=1,
        le=LEDGER_MAX_LIMIT,
        description="Page size for the ledger list (1-100, default 20).",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Offset into the time-desc result set for pagination.",
    ),
    fact_type: str | None = Query(
        default=None,
        description="Optional fact_type chip filter (action / claim / measurement).",
    ),
    user: User = Depends(get_current_user),
) -> LedgerResponse:
    """Paged, time-desc list of validated facts in one KS.

    Filters:
      - knowledge_space_id == :space_id  (hard pin)
      - validation_method == 'manual'    (hard pin; auto rows never surface)
      - retracted_at NOT exists          (soft-deleted facts are hidden)
      - fact_type == :fact_type          (when the query param is set)

    Sort: validated_at desc, _id desc as a stable tie-break.

    Pagination: ES `from_` + `size`. `limit` clamped to [1, 100] by
    FastAPI's Query validators; `offset` is non-negative.

    Fail-soft: an ES error returns an empty LedgerResponse rather than
    a 500 — same contract as the recall + facts endpoints. Auth /
    space resolution still uses the standard 401/403/404 chain.
    """
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
    finally:
        session.close()
    ks_id = str(space_id)

    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": ks_id}},
        {"term": {"validation_method": "manual"}},
    ]
    # Optional fact_type chip filter. We accept the param as a free
    # string and rely on the ES term filter to no-op when the value
    # doesn't match any docs — defensive, since the FE only sends
    # one of the three known values.
    if fact_type:
        filters.append({"term": {"fact_type": fact_type}})

    body: dict[str, Any] = {
        "from": offset,
        "size": limit,
        # Tie-break on fact_uid (keyword) so the order is stable when
        # multiple facts share an exact validated_at (e.g. an accept-all
        # batch). _id fielddata access is disabled in ES 8+
        # (indices.id_field_data.enabled=false), which silently broke
        # the previous sort and made every ledger call fall through to
        # the fail-soft empty path. fact_uid is keyword-indexed so it
        # sorts without fielddata.
        "sort": [
            {"validated_at": {"order": "desc"}},
            {"fact_uid": {"order": "desc"}},
        ],
        "query": {
            "bool": {
                "filter": filters,
                "must_not": [
                    {"exists": {"field": "retracted_at"}},
                ],
            },
        },
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
    except Exception as exc:  # noqa: BLE001 — degrade quietly
        logger.warning("ledger: ES search failed: %s", exc)
        return LedgerResponse(facts=[], total=0, limit=limit, offset=offset)

    hits = list(resp.get("hits", {}).get("hits") or [])
    recall_facts: list[RecallFact] = []
    for hit in hits:
        fact = _hit_to_fact(hit)
        if fact is not None:
            recall_facts.append(fact)

    # Reuse the same label enrichment chain RECALL / FACTS use so the
    # ledger card can render subject_label / object_label without a
    # second round-trip — operates on RecallFact[] before projection.
    recall_facts = _enrich_with_labels(recall_facts, ks_id)

    items = [_project_to_ledger_item(f) for f in recall_facts]

    total_raw = (resp.get("hits") or {}).get("total")
    if isinstance(total_raw, dict):
        total_int = int(total_raw.get("value") or 0)
    else:
        total_int = int(total_raw or 0)

    return LedgerResponse(
        facts=items,
        total=total_int,
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# fix/r1-recall-redesign — AI 브리핑 (entity 개관).
#
# PO directive (2026-06-24):
#   "빈 요약박스 → AI 브리핑: '검색 결과 요약 · OOO' 이 칩만 있고 텍스트
#    없음 → entity 개관 브리핑 추가. 검증 fact 만 근거 (grounding P1·P2).
#    ORACLE 질문응답과 구분 (개관 vs 질문). 비용가드 (캐싱/온디맨드 버튼)."
#
# Distinct from /api/assistant/brief (ORACLE):
#   · ORACLE answers a question: "What did X say?" → answers from facts.
#   · This BRIEFING is an overview: "Summarise what's verified about X."
#     The LLM is asked to compose 1-3 sentences of zh-ko narrative
#     surface over the current recall result, NOT to answer a question.
#
# Zero-hallucination contract (grounding P1·P2):
#   1. The LLM only ever sees facts that came out of the same recall
#      pipeline the user just ran (the call re-runs recall internally,
#      no second source of truth).
#   2. The LLM is instructed to cite by fact_uid; we then filter the
#      cited uids against the candidate set so the response can never
#      reference a fact that wasn't in the input. A briefing that
#      lands with 0 grounded uids returns grounded=False and an empty
#      text (the FE renders a "검증된 fact 없음" notice).
#
# Cost guard (★ PO):
#   · On-demand: this endpoint is called from a "AI 브리핑 보기" button
#     on the FE, NOT auto-fired on every recall search.
#   · Cache: in-memory LRU keyed on
#       (space_id, query, sorted(entity_uids), sorted(fact_uids)).
#     A repeat click within `_BRIEFING_CACHE_TTL_S` returns cached=True
#     and skips the LLM call. The fact_uid set is part of the key so
#     a stale cache can't bleed across a fact mutation (retract/edit
#     changes the fact_uid composition → cache miss → fresh compute).
# ---------------------------------------------------------------------------


_BRIEFING_CACHE_TTL_S = 30 * 60  # 30 minutes
_BRIEFING_CACHE_MAX = 256
_briefing_cache: dict[tuple[str, str, tuple[str, ...], tuple[str, ...]], tuple[float, RecallBriefingResponse]] = {}


def _briefing_cache_get(
    key: tuple[str, str, tuple[str, ...], tuple[str, ...]],
) -> RecallBriefingResponse | None:
    """In-memory cache lookup with TTL eviction.

    Returns None on miss / expired entry. Threadsafe-ish: the dict
    mutation is not atomic but the only invariant we need is that an
    expired entry is rebuilt on next access — losing a write to a
    race is fine.
    """
    entry = _briefing_cache.get(key)
    if entry is None:
        return None
    ts, resp = entry
    import time as _time
    if _time.time() - ts > _BRIEFING_CACHE_TTL_S:
        _briefing_cache.pop(key, None)
        return None
    # Return a copy with cached=True so a stale-cache hit is observable
    # in the response (and tests can assert the second call was free).
    return resp.model_copy(update={"cached": True})


def _briefing_cache_put(
    key: tuple[str, str, tuple[str, ...], tuple[str, ...]],
    resp: RecallBriefingResponse,
) -> None:
    """Insert with a coarse LRU bound. When we hit the size cap, drop
    the oldest entry — good enough for a hand-thrown in-memory cache."""
    import time as _time
    if len(_briefing_cache) >= _BRIEFING_CACHE_MAX:
        # Find the oldest timestamp and evict it. O(N) but N is tiny.
        oldest_key = min(_briefing_cache.items(), key=lambda kv: kv[1][0])[0]
        _briefing_cache.pop(oldest_key, None)
    # Always store with cached=False so the FIRST hit (compute path)
    # reports cached=False, and the helper above flips it to True on
    # subsequent reads.
    _briefing_cache[key] = (_time.time(), resp.model_copy(update={"cached": False}))


BRIEFING_SYSTEM_PROMPT = """\
당신은 Lucid 검증 사실 개관 작성자입니다. 아래 검증된 사실 목록만 근거로
1-3 문장의 한국어 개관을 작성하세요.

규칙:
1. 사실 목록 밖의 정보를 추가하거나 추론하지 마세요.
2. 동일한 사실이 반복되면 한 번만 언급하세요.
3. "검증된 사실에 따르면", "보고서에 따르면" 같은 군더더기 어구를
   넣지 마세요. 사실 자체를 자연스럽게 서술하세요.
4. 질문 답변이 아니라 개관입니다. "...에 대해 답하면" 같은 어투를
   쓰지 말고 대상이 무엇이며 어떤 검증된 사실들이 있는지 요약하세요.
5. 사용한 fact_uid 들을 cited_fact_uids 에 나열하세요 (최대 8개).
6. 개관이 검증 사실에 근거하면 grounded=true.

반드시 JSON만 출력하세요:
{"briefing": "...", "cited_fact_uids": [...], "grounded": true/false}"""


def _build_briefing_user_prompt(
    query: str, facts_text: str, total_facts: int,
) -> str:
    return (
        f"검색어: {query}\n"
        f"검증된 사실 총 {total_facts}건:\n"
        f"{facts_text}\n\n"
        "위 사실들에 대한 한국어 개관을 작성하세요."
    )


def _facts_to_briefing_lines(facts: list[RecallFact]) -> str:
    """Render the recall facts as a single block for the LLM prompt.

    Format: `[fact_uid] subject_label predicate object` — one per line.
    We pull subject_label / object_label so the LLM sees readable
    Korean rather than raw uids, mirroring the ORACLE prompt path.
    """
    lines: list[str] = []
    for f in facts:
        subj = f.subject_label or f.subject_uid
        obj = f.object_label or f.object_value or ""
        pred = f.predicate_label or f.predicate
        lines.append(f"[{f.fact_uid}] {subj} {pred} {obj}".rstrip())
    return "\n".join(lines)


@router.get(
    "/recall/briefing",
    response_model=RecallBriefingResponse,
)
def recall_briefing(
    space_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=2000),
    entity: list[str] = Query(default_factory=list, alias="entity"),
    user: User = Depends(get_current_user),
) -> RecallBriefingResponse:
    """fix/r1-recall-redesign — AI 브리핑 (개관) over the recall set.

    Pipeline:
      1. Authorise space ownership (same as /recall).
      2. Re-run the recall pipeline (same kNN + entity-name + entity-link
         expansion path) so the briefing always sees exactly the same
         fact set the user saw. There is NO second retrieval logic; the
         briefing is a layer on top of recall, not a parallel path.
      3. If the recall returned 0 facts → return an empty briefing with
         grounded=False. NO LLM call (zero cost when there is nothing
         to summarise).
      4. Cache key = (space_id, q, sorted(entity), sorted(fact_uids)).
         Hit → cached=True, no LLM call.
      5. Miss → call Claude with the briefing system prompt, parse the
         JSON, filter cited_fact_uids against the candidate set so a
         hallucinated uid can never escape, store in cache.

    Failure-mode: any LLM error returns a grounded=False envelope with
    an empty briefing string. The FE renders a fallback notice.
    """
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
    finally:
        session.close()

    # Re-use the recall pipeline so the briefing is provably grounded
    # in the SAME fact set the user saw. We call the recall() route
    # function directly with the canonical defaults — no override of
    # threshold / dates, mirroring the simple-mode UX where the brief
    # button lives.
    recall_resp = recall(
        space_id=space_id,
        q=q,
        limit=RECALL_DEFAULT_K,
        entity=entity if isinstance(entity, list) else [],
        include_retracted=False,
        score_threshold=None,
        date_from=None,
        date_to=None,
        user=user,
    )

    facts = list(recall_resp.facts)
    fact_uids = tuple(sorted(f.fact_uid for f in facts))

    # Zero-fact short-circuit: no LLM spend when there's nothing to
    # summarise. This is the same zero-hallucination contract as the
    # recall route — silence is the right answer.
    if not facts:
        return RecallBriefingResponse(
            briefing="",
            fact_uids=[],
            grounded=False,
            cached=False,
            fact_count=0,
        )

    cache_key = (
        str(space_id),
        q,
        tuple(sorted(entity if isinstance(entity, list) else [])),
        fact_uids,
    )
    cached = _briefing_cache_get(cache_key)
    if cached is not None:
        return cached

    facts_text = _facts_to_briefing_lines(facts)
    user_prompt = _build_briefing_user_prompt(q, facts_text, len(facts))

    try:
        from api.structure.claude_client import call_claude_structured
        llm_out = call_claude_structured(
            BRIEFING_SYSTEM_PROMPT, user_prompt, max_tokens=600,
        )
    except Exception as exc:  # noqa: BLE001 — degrade quietly
        logger.warning("recall.briefing: LLM call failed: %s", exc)
        return RecallBriefingResponse(
            briefing="",
            fact_uids=[],
            grounded=False,
            cached=False,
            fact_count=len(facts),
        )

    candidate_uids = {f.fact_uid for f in facts}
    cited_raw = llm_out.get("cited_fact_uids") or []
    cited = [
        uid for uid in cited_raw
        if isinstance(uid, str) and uid in candidate_uids
    ][:8]
    briefing_text = (llm_out.get("briefing") or "").strip()
    grounded_flag = bool(llm_out.get("grounded", False)) and bool(cited)

    resp = RecallBriefingResponse(
        briefing=briefing_text if grounded_flag else "",
        fact_uids=cited if grounded_flag else [],
        grounded=grounded_flag,
        cached=False,
        fact_count=len(facts),
    )
    if grounded_flag:
        # Only cache grounded responses; an LLM transient failure
        # shouldn't poison the cache for the next 30 minutes.
        _briefing_cache_put(cache_key, resp)
    return resp
