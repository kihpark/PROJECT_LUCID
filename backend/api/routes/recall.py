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
    PredicateFacetItem,
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
        )
    except (KeyError, ValueError, TypeError) as exc:
        logger.warning("recall: malformed fact source dropped: %s", exc)
        return None


def _enrich_with_labels(
    facts: list[RecallFact], knowledge_space_id: str,
) -> list[RecallFact]:
    """Look up the human-readable name for every entity uid the facts
    reference, then return a new list with subject_label / object_label
    populated. Uses a single ES mget so the cost is one round-trip
    regardless of how many facts we resolve.

    Literals on `object_value` (anything that doesn't look like an
    entity ref) are left untouched — object_label is None and the
    client renders the literal as-is.
    """
    if not facts:
        return facts

    uids: dict[str, None] = {}
    for f in facts:
        if f.subject_uid:
            uids[f.subject_uid] = None
        if f.object_value and _is_entity_ref(f.object_value):
            uids[f.object_value] = None
    if not uids:
        return facts

    name_by_uid: dict[str, str] = {}
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
            name = src.get("name")
            if uid and name:
                name_by_uid[uid] = name
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("recall: label lookup failed: %s", exc)
        return facts

    out: list[RecallFact] = []
    for f in facts:
        subject_label = name_by_uid.get(f.subject_uid) if f.subject_uid else None
        object_label = (
            name_by_uid.get(f.object_value)
            if f.object_value and _is_entity_ref(f.object_value)
            else None
        )
        out.append(
            f.model_copy(update={
                "subject_label": subject_label,
                "object_label": object_label,
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


_OBJECT_CLASS_BUCKET = {
    "organization": "organization",
    "person": "person",
    "place": "place",
}


def _bucket_for(class_name: str | None) -> str:
    if not class_name:
        return "other"
    return _OBJECT_CLASS_BUCKET.get(class_name.lower(), "other")


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

    if not counts:
        return RecallFacets(predicates=predicates)

    # Single mget for entity {name, class}.
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
                label_class[uid] = (src["name"], src.get("class"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: facet label mget failed: %s", exc)

    buckets: dict[str, list[EntityFacetItem]] = {
        "organization": [], "person": [], "place": [], "other": [],
    }
    for uid, c in counts.items():
        name, cls = label_class.get(uid, (uid, None))
        item = EntityFacetItem(uid=uid, name=name, count=c)
        buckets[_bucket_for(cls)].append(item)
    for v in buckets.values():
        v.sort(key=lambda i: (-i.count, i.name.lower()))

    return RecallFacets(
        entities=EntityFacets(
            organization=buckets["organization"],
            person=buckets["person"],
            place=buckets["place"],
            other=buckets["other"],
        ),
        predicates=predicates,
    )


@router.get("/recall", response_model=RecallResponse)
def recall(
    space_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=2000, description="Query"),
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

    embedding = get_embedding(q)
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

    facts: list[RecallFact] = []
    for hit in hits:
        score = float(hit.get("_score") or 0.0)
        if score < threshold:
            # Hits are sorted by score desc; first below-floor → stop.
            break
        fact = _hit_to_fact(hit)
        if fact is not None:
            facts.append(fact)

    if not facts:
        return _empty("no_facts_above_floor")

    # B-25 stage 2 / B-35 wiring: surface every other validated fact
    # in this knowledge_space that references any of the same
    # canonical Object uids. This is the graph join PO asked for —
    # "SpaceX 검색 -> SpaceX 가 subject 든 object 든 등장하는 fact 전부".
    # B-50-fix: always runs — the client filters 🔗 rows on display
    # if the user wants to hide them.
    expansion_count = 0
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

    return RecallResponse(
        signature=SIGNATURE_HIT_TEMPLATE.format(n=len(facts)),
        facts=facts,
        total=len(facts),
        expanded_count=expansion_count,
        entity_brief=brief,
        facets=facets,
    )


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
        object_value=object_value,
        object_label=object_entity.name if object_entity else None,
        validated_at=fact_doc["validated_at"],
        retracted_at=fact_doc.get("retracted_at"),
        retracted_by=fact_doc.get("retracted_by"),
        edit_history=list(fact_doc.get("edit_history") or []),
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
