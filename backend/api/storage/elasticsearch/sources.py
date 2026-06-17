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


def get_source_by_url(
    url: str, knowledge_space_id: str,
) -> dict[str, Any] | None:
    """B-48a: find by URL within a KS. Dedup at the URL level (not
    domain) so two different articles on the same site land as two
    Source docs — important for "검증된 출처 N건" counts in B-48b's
    detail panel."""
    resp = get_client().search(
        index=LUCID_SOURCES,
        query={"bool": {"filter": [
            {"term": {"knowledge_space_id": knowledge_space_id}},
            {"term": {"url": url}},
        ]}},
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
    *,
    source_job_id: str | None = None,
    captured_at: Any | None = None,
    author: str | None = None,
    published_at: Any | None = None,
) -> dict[str, Any]:
    """If a source for this (space, url) exists, bump capture_count.
    Otherwise insert a new doc.

    B-48a: dedup key is (KS, url) — same article captured twice
    increments the count; different articles on the same domain land
    as separate docs. The kwargs let the validate path attach the
    originating SourceJob and its captured_at so the detail panel
    (B-48b) can hyperlink back to the snapshot.
    """
    client = get_client()
    existing = get_source_by_url(url, knowledge_space_id)
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
        author=author,
        published_at=published_at,
        first_captured_at=utc_now(),
        capture_count=1,
        knowledge_space_id=knowledge_space_id,
        source_job_id=source_job_id,
        captured_at=captured_at,
    )
    body = src.model_dump(by_alias=True, mode="json")
    # ES doc shape uses `url` not `source_url`; rename for the wire.
    body["url"] = body.pop("source_url")
    # Strict mapping rejects nulls — drop any optional fields the
    # caller didn't supply.
    for k in ("published_at", "author", "source_job_id", "captured_at"):
        if body.get(k) is None:
            body.pop(k, None)
    client.index(
        index=LUCID_SOURCES,
        id=src.source_uid,
        document=body,
        refresh="wait_for",
    )
    return body
