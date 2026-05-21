"""ES query helpers for the lucid_facts index.

Three search modes:
  - knn_search_facts        dense vector similarity (Active Recall + Ask Lucid)
  - text_search_facts       nori (ko) / standard (en) / auto multilingual
  - faceted_search_facts    aggregations over class / tag / source for
                            Stellar (Sprint 5) faceted UI

Every query takes knowledge_space_id and adds it as a `filter` term so
results never cross user boundaries.
"""
from __future__ import annotations

import logging
from typing import Any

from api.storage.elasticsearch.client import LUCID_FACTS, get_client

logger = logging.getLogger("lucid.es.queries")


def _space_filter(knowledge_space_id: str | None) -> list[dict[str, Any]]:
    """Return a [filter] clause restricting to one knowledge space."""
    if knowledge_space_id is None:
        # Cross-space query — only legal from admin tooling. Logged loudly.
        logger.warning("ES query missing knowledge_space_id (cross-space query)")
        return []
    return [{"term": {"knowledge_space_id": knowledge_space_id}}]


def knn_search_facts(
    embedding: list[float],
    k: int = 10,
    knowledge_space_id: str | None = None,
    extra_filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """kNN over the dense_vector `embedding` field.

    extra_filters is a flat {field: value} dict applied as ES term
    filters (e.g., {"type": "proposition", "tags": "ai-governance"}).
    """
    client = get_client()
    filters = _space_filter(knowledge_space_id)
    if extra_filters:
        for field, value in extra_filters.items():
            filters.append({"term": {field: value}})

    body: dict[str, Any] = {
        "knn": {
            "field": "embedding",
            "query_vector": embedding,
            "k": k,
            "num_candidates": max(50, k * 5),
        },
        "size": k,
    }
    if filters:
        body["knn"]["filter"] = filters
    resp = client.search(index=LUCID_FACTS, body=body)
    return [hit["_source"] for hit in resp["hits"]["hits"]]


def text_search_facts(
    query: str,
    lang: str = "ko",
    knowledge_space_id: str | None = None,
    extra_filters: dict[str, Any] | None = None,
    size: int = 20,
) -> list[dict[str, Any]]:
    """Full-text search over claim + aliases.

    lang:
      'ko'   -> match claim (nori) only
      'en'   -> match claim_en (standard) only
      'auto' -> multi-match across claim + claim_en + aliases
    """
    match: dict[str, Any]
    if lang == "ko":
        match = {"match": {"claim": query}}
    elif lang == "en":
        match = {"match": {"claim_en": query}}
    elif lang == "auto":
        match = {
            "multi_match": {
                "query": query,
                "fields": ["claim^2", "claim_en", "aliases"],
                "type": "most_fields",
            }
        }
    else:
        raise ValueError(f"unknown lang: {lang!r}")

    filters = _space_filter(knowledge_space_id)
    if extra_filters:
        for field, value in extra_filters.items():
            filters.append({"term": {field: value}})

    body: dict[str, Any] = {
        "query": {
            "bool": {
                "must": [match],
                "filter": filters,
            }
        },
        "size": size,
    }
    resp = get_client().search(index=LUCID_FACTS, body=body)
    return [hit["_source"] for hit in resp["hits"]["hits"]]


def faceted_search_facts(
    knowledge_space_id: str,
    filters: dict[str, Any] | None = None,
    text_query: str | None = None,
    facets: list[str] | None = None,
    size: int = 50,
) -> dict[str, Any]:
    """Combined text/term filter + aggregations.

    `filters` is a flat {field: value | [values]} dict.
    `facets` lists which fields to aggregate on; default is
    ['type', 'tags', 'source_uids'] which gives Class / Tag / Source
    facet counts for Stellar Sprint 5.
    """
    facets = facets or ["type", "tags", "source_uids"]
    filter_clauses: list[dict[str, Any]] = _space_filter(knowledge_space_id)
    if filters:
        for field, value in filters.items():
            if isinstance(value, list):
                filter_clauses.append({"terms": {field: value}})
            else:
                filter_clauses.append({"term": {field: value}})

    must: list[dict[str, Any]] = []
    if text_query:
        must.append(
            {
                "multi_match": {
                    "query": text_query,
                    "fields": ["claim^2", "claim_en", "aliases"],
                }
            }
        )

    body: dict[str, Any] = {
        "size": size,
        "query": {"bool": {"must": must, "filter": filter_clauses}} if (must or filter_clauses) else {"match_all": {}},
        "aggs": {f"facet_{f}": {"terms": {"field": f, "size": 20}} for f in facets},
    }
    resp = get_client().search(index=LUCID_FACTS, body=body)
    results = [hit["_source"] for hit in resp["hits"]["hits"]]
    facet_results = {
        f: [
            {"value": bucket["key"], "count": bucket["doc_count"]}
            for bucket in resp["aggregations"][f"facet_{f}"]["buckets"]
        ]
        for f in facets
    }
    return {"results": results, "facets": facet_results, "total": resp["hits"]["total"]["value"]}
