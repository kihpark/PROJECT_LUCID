"""Unit test: query body shapes via mocked ES client."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from api.storage.elasticsearch import queries


def _fake_search_response() -> dict:
    return {
        "hits": {"hits": [], "total": {"value": 0}},
        "aggregations": {
            "facet_type": {"buckets": []},
            "facet_tags": {"buckets": []},
            "facet_source_uids": {"buckets": []},
        },
    }


def test_knn_search_sends_filter_with_space_id():
    fake_client = MagicMock()
    fake_client.search.return_value = {"hits": {"hits": []}}
    with patch.object(queries, "get_client", return_value=fake_client):
        queries.knn_search_facts(
            embedding=[0.0] * 1536,
            k=5,
            knowledge_space_id="space-1",
        )
    args, kwargs = fake_client.search.call_args
    body = kwargs["body"]
    assert body["knn"]["k"] == 5
    assert body["knn"]["field"] == "embedding"
    assert any(
        f.get("term", {}).get("knowledge_space_id") == "space-1"
        for f in body["knn"]["filter"]
    )


def test_text_search_korean_uses_claim_field():
    fake_client = MagicMock()
    fake_client.search.return_value = {"hits": {"hits": []}}
    with patch.object(queries, "get_client", return_value=fake_client):
        queries.text_search_facts(
            "지식 그래프",
            lang="ko",
            knowledge_space_id="space-2",
        )
    body = fake_client.search.call_args.kwargs["body"]
    must = body["query"]["bool"]["must"]
    assert {"match": {"claim": "지식 그래프"}} in must


def test_faceted_search_default_facets_are_class_tag_source():
    fake_client = MagicMock()
    fake_client.search.return_value = _fake_search_response()
    with patch.object(queries, "get_client", return_value=fake_client):
        out = queries.faceted_search_facts(knowledge_space_id="space-x")
    body = fake_client.search.call_args.kwargs["body"]
    assert set(body["aggs"].keys()) == {"facet_type", "facet_tags", "facet_source_uids"}
    assert out["facets"].keys() == {"type", "tags", "source_uids"}
