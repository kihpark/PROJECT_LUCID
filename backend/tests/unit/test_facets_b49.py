"""Unit tests for B-49 facet aggregation logic.

The helper bucketises entity uids by their `class` from a single
ES mget, sorts by count desc + name asc, and skips literal
object_value uids. We exercise the helper directly with stubbed ES
search/mget responses."""
from __future__ import annotations

from unittest.mock import MagicMock, patch


def _agg_response(subject_buckets, object_buckets, predicate_buckets):
    return {
        "aggregations": {
            "subjects": {"buckets": subject_buckets},
            "objects": {"buckets": object_buckets},
            "predicates": {"buckets": predicate_buckets},
        },
    }


def _mget_response(docs):
    return {"docs": docs}


def _doc(uid, name, cls, found=True):
    return {
        "_id": uid,
        "found": found,
        "_source": {"object_uid": uid, "name": name, "class": cls},
    }


def test_facets_empty_when_fact_uids_empty():
    from api.routes.recall import _facets_for

    out = _facets_for([], "ks-1")
    assert out.entities.organization == []
    assert out.predicates == []


def test_facets_bucket_by_class_and_sort_by_count_desc():
    from api.routes.recall import _facets_for

    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[
            {"key": "11111111-2222-4333-8444-555555555555", "doc_count": 3},
            {"key": "22222222-3333-4444-9555-666666666666", "doc_count": 2},
        ],
        object_buckets=[
            {"key": "11111111-2222-4333-8444-555555555555", "doc_count": 1},
            {"key": "85.7 billion USD", "doc_count": 4},  # literal; must NOT enter facets
        ],
        predicate_buckets=[
            {"key": "is_underwriter_for", "doc_count": 2},
            {"key": "total_funds_raised", "doc_count": 1},
        ],
    )
    client.mget.return_value = _mget_response([
        _doc("11111111-2222-4333-8444-555555555555", "SpaceX", "organization"),
        _doc("22222222-3333-4444-9555-666666666666", "Goldman Sachs", "organization"),
    ])

    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1", "fn-2"], "ks-1")

    orgs = out.entities.organization
    assert [(e.uid, e.count) for e in orgs] == [
        ("11111111-2222-4333-8444-555555555555", 4),    # subject 3 + object 1
        ("22222222-3333-4444-9555-666666666666", 2),
    ]
    # Literal didn't enter any bucket.
    assert all(item.uid != "85.7 billion USD" for item in out.entities.other)
    # Predicates carried over verbatim.
    assert [(p.name, p.count) for p in out.predicates] == [
        ("is_underwriter_for", 2),
        ("total_funds_raised", 1),
    ]


def test_facets_persons_and_other_bucket():
    """fix/recall-facet-bucket-expand (★ M-Dogfood ⑤⑪ — PO 2026-06-30):
    v3 closed set 10 class 1:1 bucket. 옛 시절 metric / place 가 모두
    "other" 로 떨어졌던 것이 → metric / location (place=legacy alias)
    각각 제 버킷에 들어간다. "other" 는 unknown / null fallback 만."""
    from api.routes.recall import _facets_for

    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[
            {"key": "33333333-4444-4555-a666-777777777777", "doc_count": 1},
            {"key": "44444444-5555-4666-b777-888888888888", "doc_count": 2},   # class=metric -> 'metric'
            {"key": "55555555-6666-4777-8888-999999999999", "doc_count": 3},  # class=place (legacy) -> 'location'
        ],
        object_buckets=[],
        predicate_buckets=[],
    )
    client.mget.return_value = _mget_response([
        _doc("33333333-4444-4555-a666-777777777777", "Elon Musk", "person"),
        _doc("44444444-5555-4666-b777-888888888888", "share price", "metric"),
        _doc("55555555-6666-4777-8888-999999999999", "Seoul", "place"),
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")
    assert [e.uid for e in out.entities.person] == ["33333333-4444-4555-a666-777777777777"]
    # ★ class=metric → 'metric' bucket (옛 "other" 비대 해소).
    assert [e.uid for e in out.entities.metric] == ["44444444-5555-4666-b777-888888888888"]
    # ★ class=place → 'location' bucket (legacy alias).
    assert [e.uid for e in out.entities.location] == ["55555555-6666-4777-8888-999999999999"]
    # ★ "other" 는 unknown 만 (place / metric 떨어지지 않음).
    assert out.entities.other == []


def test_facets_unknown_uid_label_falls_back_to_uid_text():
    """An entity that's not in lucid_objects (e.g. wiped or old)
    still appears in the facets — name defaults to its uid so the
    user can at least click it. Class defaults to 'other' since we
    can't resolve it."""
    from api.routes.recall import _facets_for

    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[{"key": "66666666-7777-4888-8999-aaaaaaaaaaaa", "doc_count": 1}],
        object_buckets=[],
        predicate_buckets=[],
    )
    client.mget.return_value = _mget_response([
        {"_id": "66666666-7777-4888-8999-aaaaaaaaaaaa", "found": False},
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")
    assert out.entities.other[0].uid == "66666666-7777-4888-8999-aaaaaaaaaaaa"
    assert out.entities.other[0].name == "66666666-7777-4888-8999-aaaaaaaaaaaa"


def test_facets_degrade_quietly_on_es_failure():
    """ES errors return an empty RecallFacets envelope, never 500."""
    from api.routes.recall import _facets_for

    client = MagicMock()
    client.search.side_effect = RuntimeError("ES down")
    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")
    assert out.entities.organization == []
    assert out.predicates == []
