"""Fact CRUD on the lucid_facts ES index.

Operations:
  - create_fact         insert a FactNode; auto-fills embedding via OpenAI
  - get_fact_by_uid     by-id fetch
  - update_fact         partial update; claim changes append to aliases
                        and edit_history
  - delete_fact         drop the doc + clean up parent Object.fact_uids
  - bulk_create_facts   ES bulk API for batch inserts (Sprint 3 use)

All operations require a knowledge_space_id to scope the data per user.
"""
from __future__ import annotations

import logging
from typing import Any

from elasticsearch.helpers import bulk

from api.models.base import utc_now
from api.models.facts import EditRecord, FactNode
from api.storage.elasticsearch.client import LUCID_FACTS, LUCID_OBJECTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding

logger = logging.getLogger("lucid.es.facts")


def _serialize_fact(fact: FactNode, with_embedding: bool = True) -> dict[str, Any]:
    """Pydantic FactNode -> ES document body.

    Uses model_dump(by_alias=True) so the `type` alias replaces `type_`.
    `embedding` is filled when with_embedding=True and the OpenAI key
    is configured.
    """
    body = fact.model_dump(by_alias=True, mode="json")
    body["created_at"] = body.get("validated_at") or utc_now().isoformat()
    body["updated_at"] = body["created_at"]
    if with_embedding:
        emb = get_embedding(fact.claim)
        body["embedding"] = list(emb) if emb is not None else None
        if emb is None:
            body.pop("embedding", None)  # ES strict mapping rejects null on dense_vector
    return body


def create_fact(fact: FactNode, with_embedding: bool = True) -> str:
    """Insert a FactNode into the lucid_facts index. Returns fact_uid."""
    client = get_client()
    body = _serialize_fact(fact, with_embedding=with_embedding)
    client.index(index=LUCID_FACTS, id=fact.fact_uid, document=body, refresh="wait_for")
    logger.info("Created fact %s in space %s", fact.fact_uid, fact.knowledge_space_id)
    return fact.fact_uid


def get_fact_by_uid(uid: str) -> dict[str, Any] | None:
    """Fetch a fact by its UID. Returns the source dict or None."""
    client = get_client()
    if not client.exists(index=LUCID_FACTS, id=uid):
        return None
    return client.get(index=LUCID_FACTS, id=uid)["_source"]


def update_fact(uid: str, updates: dict[str, Any], editor_uid: str) -> dict[str, Any]:
    """Partial update. Claim changes go to aliases + edit_history automatically.

    Returns the updated document body. Raises ValueError if the fact
    does not exist.
    """
    current = get_fact_by_uid(uid)
    if current is None:
        raise ValueError(f"Fact {uid} not found")

    body_update: dict[str, Any] = {}
    if "claim" in updates and updates["claim"] != current["claim"]:
        # Append the old claim to aliases so search continues to hit it.
        new_aliases = list(current.get("aliases") or [])
        new_aliases.append(current["claim"])
        body_update["aliases"] = new_aliases

        # Add an edit_history entry.
        edit = EditRecord(
            from_claim=current["claim"],
            to_claim=updates["claim"],
            edited_by=editor_uid,
        )
        new_history = list(current.get("edit_history") or [])
        new_history.append(edit.model_dump(mode="json"))
        body_update["edit_history"] = new_history

        # If the user changed the claim, recompute embedding too.
        emb = get_embedding(updates["claim"])
        if emb is not None:
            body_update["embedding"] = list(emb)

    body_update.update({k: v for k, v in updates.items() if k != "edit_history"})
    body_update["updated_at"] = utc_now().isoformat()

    client = get_client()
    client.update(index=LUCID_FACTS, id=uid, doc=body_update, refresh="wait_for")
    return get_fact_by_uid(uid) or {}


def delete_fact(uid: str) -> bool:
    """Delete a fact + scrub it from any Object.fact_uids list."""
    client = get_client()
    if not client.exists(index=LUCID_FACTS, id=uid):
        return False

    # Find Objects that reference this fact, then update each in turn.
    objects_resp = client.search(
        index=LUCID_OBJECTS,
        query={"term": {"fact_uids": uid}},
        size=1000,
    )
    for hit in objects_resp["hits"]["hits"]:
        obj_uid = hit["_id"]
        old_list = hit["_source"].get("fact_uids", [])
        new_list = [u for u in old_list if u != uid]
        client.update(
            index=LUCID_OBJECTS,
            id=obj_uid,
            doc={"fact_uids": new_list, "updated_at": utc_now().isoformat()},
            refresh="wait_for",
        )

    client.delete(index=LUCID_FACTS, id=uid, refresh="wait_for")
    return True


def find_fact_by_spo(
    knowledge_space_id: str,
    subject_uid: str,
    predicate: str,
    object_value: str,
) -> dict[str, Any] | None:
    """B-48a S/P/O dedup lookup. Returns the existing FactNode source
    dict (including fact_uid + source_uids) for this (KS, subject,
    predicate, object) triple, or None if no validated fact matches.

    PO directive 2026-06-18 [B-48 decision 1]: dedup key is the canonical
    triple only — claim text is NOT part of the key. Two captures of the
    same proposition with slightly different phrasing collapse to a
    single FactNode + N source_uids.
    """
    client = get_client()
    try:
        resp = client.search(
            index=LUCID_FACTS,
            query={"bool": {"filter": [
                {"term": {"knowledge_space_id": knowledge_space_id}},
                {"term": {"subject_uid": subject_uid}},
                {"term": {"predicate": predicate}},
                {"term": {"object_value": object_value}},
            ]}},
            size=1,
        )
    except Exception as exc:  # noqa: BLE001 - dedup degrades quietly
        logger.warning("find_fact_by_spo failed: %s", exc)
        return None
    hits = resp.get("hits", {}).get("hits") or []
    return hits[0].get("_source") if hits else None


def attach_source_to_fact(fact_uid: str, source_uid: str) -> bool:
    """B-48a: append `source_uid` to an existing FactNode.source_uids
    if it isn't already in the list. Idempotent — repeated calls with
    the same source_uid don't grow the list.

    Returns True when the list was modified (i.e. a new source was
    added), False when the source was already present or the fact
    no longer exists.
    """
    client = get_client()
    if not client.exists(index=LUCID_FACTS, id=fact_uid):
        return False
    current = client.get(index=LUCID_FACTS, id=fact_uid)["_source"]
    existing = list(current.get("source_uids") or [])
    if source_uid in existing:
        return False
    existing.append(source_uid)
    client.update(
        index=LUCID_FACTS,
        id=fact_uid,
        doc={"source_uids": existing, "updated_at": utc_now().isoformat()},
        refresh="wait_for",
    )
    return True


def count_active_facts(
    es: Any | None = None, *, knowledge_space_id: str,
) -> int:
    """B-61 cold-start signal — count non-retracted facts in a space.

    Used by GET /api/auth/me to decide whether the FE shows the
    personalised welcome line above the cold-start 3-step card. A fact
    counts as "active" when `retracted_at` is not set (mirrors the
    recall route filter at recall.py:145).

    Best-effort: failures (ES down, index missing, count API hiccup)
    return 0 rather than raising — /me must stay 200 even when ES is
    unreachable so the SPA can still render.
    """
    client = es if es is not None else get_client()
    try:
        res = client.count(
            index=LUCID_FACTS,
            body={
                "query": {
                    "bool": {
                        "filter": [
                            {"term": {"knowledge_space_id": knowledge_space_id}},
                        ],
                        "must_not": [
                            {"exists": {"field": "retracted_at"}},
                        ],
                    }
                }
            },
        )
        return int(res.get("count", 0))
    except Exception as exc:  # noqa: BLE001 — count is best-effort
        logger.warning("count_active_facts failed for %s: %s", knowledge_space_id, exc)
        return 0


def bulk_create_facts(facts: list[FactNode], with_embedding: bool = True) -> list[str]:
    """ES bulk API insert. Returns the list of created fact_uids.

    Uses chunk_size=500. Per-fact embedding still hits OpenAI individually
    via the LRU cache (batch embedding helper is in embeddings.py).
    """
    if not facts:
        return []
    actions = []
    uids: list[str] = []
    for f in facts:
        body = _serialize_fact(f, with_embedding=with_embedding)
        actions.append(
            {
                "_op_type": "index",
                "_index": LUCID_FACTS,
                "_id": f.fact_uid,
                "_source": body,
            }
        )
        uids.append(f.fact_uid)
    client = get_client()
    bulk(client, actions, chunk_size=500, refresh="wait_for")
    return uids

# --- B-62 structure-resolve ----------------------------------------------


def _find_fact_by_canonical_key(
    *,
    knowledge_space_id: str,
    subject_entity_id: str,
    predicate_code: str,
    object_canonical: str,
    fact_type: str | None = None,
    predicate: str | None = None,
) -> dict[str, Any] | None:
    """B-62 canonical S/P/O dedup lookup.

    feat/stage3-predicate-code-fact-type — the dedup is bound to
    `fact_type` (3종 bucket) + natural-language `predicate` whenever they
    are supplied. predicate_code stays in the filter chain as a legacy
    co-key so already-indexed facts with no fact_type stamp still dedup
    on their original semantics. New writes (which always carry
    fact_type via the v0.2.0 LLM payload) collapse on the
    (subject_uid, fact_type, predicate, object_canonical) 4-key.

    Skips retracted facts and only matches validation_method='manual'
    so a flaky duplicate auto-write never collapses with a user-validated
    fact. Returns the existing _source dict or None.
    """
    client = get_client()
    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": knowledge_space_id}},
        {"term": {"subject_uid": subject_entity_id}},
        {"term": {"object_canonical": object_canonical}},
        {"term": {"validation_method": "manual"}},
    ]
    # Stage 3: prefer fact_type (3종 bucket) when present; otherwise fall
    # back to predicate_code (legacy English OPL code) so already-indexed
    # facts still collapse on their original key.
    if fact_type:
        filters.append({"term": {"fact_type": fact_type}})
    elif predicate_code:
        filters.append({"term": {"predicate_code": predicate_code}})
    # Natural-language predicate tie-breaker (lowercased keyword
    # match). When the LLM emits "밝혔다" vs "밝혔습니다" these still
    # differ — the PO accepts the weak conjugation duplicate; a human
    # cleans it up downstream. We compare the predicate field (keyword)
    # exact-match (no normalization). When predicate is empty we skip
    # this filter so the older lookup behavior is preserved.
    if predicate:
        filters.append({"term": {"predicate": predicate}})
    try:
        resp = client.search(
            index=LUCID_FACTS,
            query={"bool": {
                "filter": filters,
                "must_not": [{"exists": {"field": "retracted_at"}}],
            }},
            size=1,
        )
    except Exception as exc:  # noqa: BLE001 - dedup degrades quietly
        logger.warning("_find_fact_by_canonical_key failed: %s", exc)
        return None
    hits = resp.get("hits", {}).get("hits") or []
    return hits[0].get("_source") if hits else None


def insert_or_dedup_fact(
    *,
    subject_entity_id: str,
    predicate_code: str,
    object_ref: dict[str, Any],
    knowledge_space_id: str,
    source_uid: str,
    original_surface: str,
    capture_lang: str,
    object_value: str | None = None,
    claim: str | None = None,
    fact_type: str = "proposition",
    validator_id: str | None = None,
    tags: list[str] | None = None,
    needs_review: bool = False,
    validation_method: str = "manual",
    negation_flag: bool = False,
    negation_scope: str | None = None,
    es_client: Any | None = None,
    extra_es_fields: dict[str, Any] | None = None,
    predicate_label: str | None = None,
) -> tuple[str, bool]:
    """B-62: insert a fact OR dedup against an existing one by canonical key.

    Computes canonical_key from (subject_entity_id, predicate_code,
    object_ref). On a hit: append source_uid to the existing doc's
    source_uids[] and return (existing_fact_uid, False). On a miss:
    insert a NEW fact doc with the canonical fields populated AND the
    legacy surface fields (predicate, object_value) so the recall
    display path keeps working.

    object_ref must be a dict-shaped CanonicalEntityRef
    ({"kind": "entity", "uid": "..."}) or CanonicalLiteralRef
    ({"kind": "literal", "value": "..."}). The legacy `object_value`
    string is taken from the literal value or - when the object is an
    entity reference - the surface text the caller passes (so recall
    display still resolves to a human-readable label).

    Returns (fact_uid, was_created). was_created=False indicates a
    dedup hit; the fact_uid points at the EXISTING doc.

    B-62 natural-spo-display: `predicate_label` is the user-facing
    English gloss for this fact. On INSERT we persist it; on DEDUP HIT
    we do NOT overwrite the existing label — the first capture wins so
    a later capture with a different surface phrasing cannot rewrite
    the display. The label is NEVER part of canonical_key.
    """
    from api.models.base import new_uid as _new_uid
    from api.storage.canonical import canonical_key, object_canonical

    client = es_client if es_client is not None else get_client()

    # Build canonical key + canonical object string.
    ckey = canonical_key(subject_entity_id, predicate_code, object_ref)  # type: ignore[arg-type]
    obj_canon = object_canonical(object_ref)  # type: ignore[arg-type]

    # Dedup: by canonical fields (subject_entity_id, predicate_code,
    # canonical object string). We do NOT use the surface fields for
    # the dedup query - that is the whole point of B-62.
    try:
        if es_client is None:
            existing = _find_fact_by_canonical_key(
                knowledge_space_id=knowledge_space_id,
                subject_entity_id=subject_entity_id,
                predicate_code=predicate_code,
                object_canonical=obj_canon,
                fact_type=fact_type,
                predicate=(original_surface or predicate_code).strip().lower(),
            )
        else:
            inj_filters: list[dict[str, Any]] = [
                {"term": {"knowledge_space_id": knowledge_space_id}},
                {"term": {"subject_uid": subject_entity_id}},
                {"term": {"object_canonical": obj_canon}},
                {"term": {"validation_method": validation_method}},
            ]
            if fact_type:
                inj_filters.append({"term": {"fact_type": fact_type}})
            elif predicate_code:
                inj_filters.append({"term": {"predicate_code": predicate_code}})
            inj_predicate_norm = (original_surface or predicate_code or "").strip().lower()
            if inj_predicate_norm:
                inj_filters.append({"term": {"predicate": inj_predicate_norm}})
            resp = client.search(
                index=LUCID_FACTS,
                query={"bool": {
                    "filter": inj_filters,
                    "must_not": [{"exists": {"field": "retracted_at"}}],
                }},
                size=1,
            )
            hits = resp.get("hits", {}).get("hits") or []
            existing = hits[0].get("_source") if hits else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("canonical dedup search failed: %s", exc)
        existing = None

    if existing is not None:
        existing_uid = existing.get("fact_uid")
        if existing_uid:
            # Append source_uid in place (reuse the legacy attach helper
            # if we are on the default client; otherwise inline-update
            # so the mocked-client test path works without monkey-patches).
            try:
                if es_client is None:
                    attach_source_to_fact(existing_uid, source_uid)
                else:
                    src_existing = list(existing.get("source_uids") or [])
                    if source_uid and source_uid not in src_existing:
                        src_existing.append(source_uid)
                        client.update(
                            index=LUCID_FACTS,
                            id=existing_uid,
                            doc={
                                "source_uids": src_existing,
                                "updated_at": utc_now().isoformat(),
                            },
                            refresh="wait_for",
                        )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "attach source on dedup hit failed for %s: %s",
                    existing_uid, exc,
                )
            return existing_uid, False

    # Miss: insert a fresh canonical fact doc.
    fact_uid = _new_uid()
    # Recall display path reads object_value (surface). For entity refs,
    # fall back to the entity uid string; for literals, use the literal value.
    legacy_object_value = object_value
    if legacy_object_value is None:
        if object_ref.get("kind") == "literal":
            legacy_object_value = object_ref.get("value") or ""
        else:
            legacy_object_value = object_ref.get("uid") or ""
    legacy_predicate = original_surface or predicate_code

    body: dict[str, Any] = {
        "fact_uid": fact_uid,
        "claim": claim or legacy_object_value,
        "type": fact_type,
        "subject_uid": subject_entity_id,
        "predicate": legacy_predicate,
        "object_value": legacy_object_value,
        "validated_at": utc_now().isoformat(),
        "validation_method": validation_method,
        "validator_id": validator_id or "system",
        "source_uids": [source_uid] if source_uid else [],
        # B-62 canonical fields
        "predicate_code": predicate_code,
        "original_surface": original_surface,
        "capture_lang": capture_lang,
        "object_canonical": obj_canon,
        "canonical_key": ckey,
        # B-62 natural-spo-display: persist the natural English predicate
        # label so the recall display has a rich gloss. The label NEVER
        # participates in canonical_key (key stays subject_uid /
        # predicate_code / object_canonical) — two captures with
        # different labels but the same triple dedup here.
        "predicate_label": predicate_label,
        "tags": list(tags or []),
        "needs_review": bool(needs_review),
        "aliases": [],
        "override_warning": False,
        "negation_flag": bool(negation_flag),
        "knowledge_space_id": knowledge_space_id,
        "edit_history": [],
        "locators": [],
        "created_at": utc_now().isoformat(),
        "updated_at": utc_now().isoformat(),
    }
    if negation_scope:
        body["negation_scope"] = negation_scope
    if extra_es_fields:
        body.update(extra_es_fields)

    # search-embedding-restore (v0.2.0 graduation gate): compute dense
    # embedding on the canonical insert path so kNN recall can actually
    # rank these facts. Without this, every fact written through B-62's
    # insert_or_dedup path lands with no embedding field, kNN matches
    # nothing, and the recall route silently falls through to wildcard
    # entity-name lookup — which is the bug PO surfaced (선거관리위원회
    # → 최저임금위원회). Embedding key absent / network fail → tuple is
    # None → we omit the field rather than write a zero vector, since
    # ES dense_vector mapping is strict.
    try:
        emb = get_embedding(claim or legacy_object_value)
    except Exception as exc:  # noqa: BLE001
        logger.warning("insert_or_dedup_fact embed failed for %s: %s", fact_uid, exc)
        emb = None
    if emb is not None:
        body["embedding"] = list(emb)

    try:
        client.index(
            index=LUCID_FACTS,
            id=fact_uid,
            document=body,
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "insert_or_dedup_fact insert failed for %s: %s",
            fact_uid, exc,
        )
    return fact_uid, True
