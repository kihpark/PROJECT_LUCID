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
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from api.models.recall import RecallFact, RecallResponse
from api.security import get_current_user
from api.storage.elasticsearch.client import LUCID_FACTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding
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


def _entity_link_facts(
    entity_uids: list[str],
    knowledge_space_id: str,
    *,
    exclude_fact_uids: set[str],
    max_hits: int = 50,
) -> list[dict[str, Any]]:
    """Return hit dicts for every validated fact whose subject_uid OR
    object_value matches any of `entity_uids`. Excludes facts already
    in the embedding pass."""
    if not entity_uids:
        return []
    body: dict[str, Any] = {
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                    {"term": {"validation_method": "manual"}},
                    {"bool": {
                        "should": [
                            {"terms": {"subject_uid": entity_uids}},
                            {"terms": {"object_value": entity_uids}},
                        ],
                        "minimum_should_match": 1,
                    }},
                ],
            },
        },
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
    embedding: list[float], knowledge_space_id: str, k: int,
) -> list[dict[str, Any]]:
    """ES kNN with hard filters: space + validation_method=manual.

    Returns [{_source, _score}] hit dicts so the caller can apply the
    score floor + serialise. The validation_method filter is enforced
    inside the ES `knn.filter` clause, not as a post-fetch Python
    filter, so non-manual facts can never leak even on a partial fail.
    """
    body: dict[str, Any] = {
        "knn": {
            "field": "embedding",
            "query_vector": embedding,
            "k": k,
            "num_candidates": max(50, k * 5),
            "filter": [
                {"term": {"knowledge_space_id": knowledge_space_id}},
                {"term": {"validation_method": "manual"}},
            ],
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


@router.get("/recall", response_model=RecallResponse)
def recall(
    space_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=2000, description="Query"),
    limit: int = Query(default=RECALL_DEFAULT_K, ge=1, le=RECALL_MAX_K),
    user: User = Depends(get_current_user),
) -> RecallResponse:
    """Return validated facts whose embedding is close to `q`.

    Behaviour invariants (DR-089):
      - ONLY facts with `validation_method='manual'` are returned.
        Non-manual rows never reach the response, even if they exist in
        the index (enforced inside the ES kNN filter clause AND
        re-checked in the serialiser).
      - 0 hits — whether the index is empty, the query is irrelevant,
        or every hit is below RECALL_SCORE_FLOOR — produces the same
        empty envelope. We do NOT generate, paraphrase, or augment.
      - Korean queries work first-class because the embedding model
        (OpenAI text-embedding-3-small) is multilingual.

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

    embedding = get_embedding(q)
    if embedding is None:
        return _empty("embedding_unavailable")

    try:
        hits = _knn_facts_validated_only(list(embedding), str(ks.id), limit)
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("recall: ES kNN failed: %s", exc)
        return _empty("es_unavailable")

    facts: list[RecallFact] = []
    for hit in hits:
        score = float(hit.get("_score") or 0.0)
        if score < RECALL_SCORE_FLOOR:
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
    # Degrade quietly on any ES error — the embedding matches above
    # are already a complete answer.
    entity_uids = _collect_entity_uids(facts)
    already = {f.fact_uid for f in facts}
    expansion_count = 0
    try:
        link_hits = _entity_link_facts(
            entity_uids, str(ks.id),
            exclude_fact_uids=already,
            max_hits=max(RECALL_MAX_K, limit * 5),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("recall: entity-link expansion failed: %s", exc)
        link_hits = []
    for hit in link_hits:
        fact = _hit_to_fact(hit)
        if fact is None:
            continue
        fact = fact.model_copy(update={"match_kind": "entity_link"})
        facts.append(fact)
        expansion_count += 1

    facts = _enrich_with_labels(facts, str(ks.id))

    return RecallResponse(
        signature=SIGNATURE_HIT_TEMPLATE.format(n=len(facts)),
        facts=facts,
        total=len(facts),
        expanded_count=expansion_count,
    )
