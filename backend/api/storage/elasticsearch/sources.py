"""Source CRUD on the lucid_sources ES index.

The interesting operation is `create_or_update_source` — when the
same (knowledge_space_id, domain) pair is captured again, the
existing doc has `capture_count` incremented in place rather than a
new doc being created. This makes source-repetition signal cheap to
query.
"""
from __future__ import annotations

import logging
from typing import Any

from api.models.base import new_uid, utc_now
from api.models.source import Source
from api.storage.elasticsearch.client import LUCID_SOURCES, get_client

logger = logging.getLogger("lucid.es.sources")


def get_source_by_domain(
    domain: str, knowledge_space_id: str
) -> dict[str, Any] | None:
    """Find an existing source by (knowledge_space_id, domain)."""
    resp = get_client().search(
        index=LUCID_SOURCES,
        query={
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": knowledge_space_id}},
                    {"term": {"domain": domain}},
                ]
            }
        },
        size=1,
    )
    hits = resp["hits"]["hits"]
    return hits[0]["_source"] if hits else None


def create_or_update_source(
    domain: str,
    source_type: str,
    url: str,
    knowledge_space_id: str,
    title: str | None = None,
) -> dict[str, Any]:
    """If a source for this (space, domain) exists, bump capture_count.
    Otherwise insert a new doc.
    """
    client = get_client()
    existing = get_source_by_domain(domain, knowledge_space_id)
    if existing is not None:
        new_count = (existing.get("capture_count") or 0) + 1
        client.update(
            index=LUCID_SOURCES,
            id=existing["source_uid"],
            doc={"capture_count": new_count},
            refresh="wait_for",
        )
        existing["capture_count"] = new_count
        return existing

    from api.models.source import SourceType
    src = Source(
        source_uid=new_uid(),
        domain=domain,
        source_type=SourceType(source_type),
        source_url=url,
        title=title,
        first_captured_at=utc_now(),
        capture_count=1,
        knowledge_space_id=knowledge_space_id,
    )
    body = src.model_dump(by_alias=True, mode="json")
    # ES doc shape uses `url` not `source_url`; rename for the wire.
    body["url"] = body.pop("source_url")
    body.pop("published_at", None)
    body.pop("author", None)
    client.index(
        index=LUCID_SOURCES,
        id=src.source_uid,
        document=body,
        refresh="wait_for",
    )
    return body
