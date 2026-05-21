"""Object CRUD on the lucid_objects ES index.

Operations:
  - create_object        insert + auto-embedding of name
  - get_object_by_uid    fetch
  - update_object        partial update; re-embeds when `name` changes
  - delete_object        drop the doc + scrub any references from
                         connected_objects on other docs
  - link_objects         symmetric — appends to both A and B's
                         connected_objects list
  - unlink_objects       symmetric removal
  - get_1hop_neighbors   fetch all objects connected to a given one,
                         optionally filtered by link_type

knowledge_space_id is mandatory on every read/write.
"""
from __future__ import annotations

import logging
from typing import Any

from api.models.base import utc_now
from api.models.objects import Object
from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding

logger = logging.getLogger("lucid.es.objects")


def _serialize_object(obj: Object, with_embedding: bool = True) -> dict[str, Any]:
    body = obj.model_dump(by_alias=True, mode="json")
    if with_embedding:
        emb = get_embedding(obj.name)
        if emb is not None:
            body["embedding"] = list(emb)
        else:
            body.pop("embedding", None)
    return body


def create_object(obj: Object, with_embedding: bool = True) -> str:
    body = _serialize_object(obj, with_embedding=with_embedding)
    get_client().index(
        index=LUCID_OBJECTS, id=obj.object_uid, document=body, refresh="wait_for"
    )
    return obj.object_uid


def get_object_by_uid(uid: str) -> dict[str, Any] | None:
    client = get_client()
    if not client.exists(index=LUCID_OBJECTS, id=uid):
        return None
    return client.get(index=LUCID_OBJECTS, id=uid)["_source"]


def update_object(uid: str, updates: dict[str, Any]) -> dict[str, Any]:
    current = get_object_by_uid(uid)
    if current is None:
        raise ValueError(f"Object {uid} not found")
    body_update = dict(updates)
    if "name" in updates and updates["name"] != current.get("name"):
        emb = get_embedding(updates["name"])
        if emb is not None:
            body_update["embedding"] = list(emb)
    body_update["updated_at"] = utc_now().isoformat()
    get_client().update(
        index=LUCID_OBJECTS, id=uid, doc=body_update, refresh="wait_for"
    )
    return get_object_by_uid(uid) or {}


def delete_object(uid: str) -> bool:
    client = get_client()
    if not client.exists(index=LUCID_OBJECTS, id=uid):
        return False
    # Scrub references from connected_objects on every other object
    others = client.search(
        index=LUCID_OBJECTS,
        query={
            "nested": {
                "path": "connected_objects",
                "query": {"term": {"connected_objects.target_uid": uid}},
            }
        },
        size=1000,
    )
    for hit in others["hits"]["hits"]:
        other_uid = hit["_id"]
        existing = hit["_source"].get("connected_objects", [])
        cleaned = [c for c in existing if c.get("target_uid") != uid]
        client.update(
            index=LUCID_OBJECTS,
            id=other_uid,
            doc={
                "connected_objects": cleaned,
                "updated_at": utc_now().isoformat(),
            },
            refresh="wait_for",
        )

    client.delete(index=LUCID_OBJECTS, id=uid, refresh="wait_for")
    return True


def link_objects(from_uid: str, to_uid: str, link_type: str) -> bool:
    """Symmetric edge: appends to both from and to objects' connected_objects.

    Idempotent — appending the same (target_uid, link_type) pair twice
    leaves only one entry.
    """
    client = get_client()

    def _append(doc_uid: str, target_uid: str) -> None:
        doc = client.get(index=LUCID_OBJECTS, id=doc_uid)["_source"]
        existing = doc.get("connected_objects") or []
        entry = {"target_uid": target_uid, "link_type": link_type}
        if entry in existing:
            return
        existing.append(entry)
        client.update(
            index=LUCID_OBJECTS,
            id=doc_uid,
            doc={
                "connected_objects": existing,
                "updated_at": utc_now().isoformat(),
            },
            refresh="wait_for",
        )

    if not client.exists(index=LUCID_OBJECTS, id=from_uid):
        raise ValueError(f"Object {from_uid} not found")
    if not client.exists(index=LUCID_OBJECTS, id=to_uid):
        raise ValueError(f"Object {to_uid} not found")

    _append(from_uid, to_uid)
    _append(to_uid, from_uid)
    return True


def unlink_objects(from_uid: str, to_uid: str) -> bool:
    """Symmetric removal."""
    client = get_client()

    def _remove(doc_uid: str, target_uid: str) -> None:
        doc = client.get(index=LUCID_OBJECTS, id=doc_uid)["_source"]
        existing = doc.get("connected_objects") or []
        new = [c for c in existing if c.get("target_uid") != target_uid]
        if len(new) == len(existing):
            return
        client.update(
            index=LUCID_OBJECTS,
            id=doc_uid,
            doc={
                "connected_objects": new,
                "updated_at": utc_now().isoformat(),
            },
            refresh="wait_for",
        )

    if client.exists(index=LUCID_OBJECTS, id=from_uid):
        _remove(from_uid, to_uid)
    if client.exists(index=LUCID_OBJECTS, id=to_uid):
        _remove(to_uid, from_uid)
    return True


def get_1hop_neighbors(
    object_uid: str, link_type: str | None = None
) -> list[dict[str, Any]]:
    """Return the connected_objects of the given object, optionally
    filtered by link_type. Fetches the full target docs from ES."""
    src = get_object_by_uid(object_uid)
    if src is None:
        return []
    edges = src.get("connected_objects") or []
    if link_type is not None:
        edges = [e for e in edges if e.get("link_type") == link_type]
    if not edges:
        return []

    target_uids = [e["target_uid"] for e in edges]
    client = get_client()
    docs = client.mget(index=LUCID_OBJECTS, ids=target_uids)
    return [d["_source"] for d in docs["docs"] if d.get("found")]
