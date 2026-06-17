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
