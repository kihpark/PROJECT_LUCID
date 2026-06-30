"""fix/recall-facet-bucket-expand (★ M-Dogfood ⑤⑪ — PO 2026-06-30) —
v3 closed-set 10 class facet bucket 검증.

★ 옛 root cause: _OBJECT_CLASS_BUCKET 가 organization / person / place
3 class 만 1:1 매핑하고 나머지 (concept / resource / event / metric /
knowledge / group / task / location) 는 "other" fallback 으로 떨어져
"기타" 비대를 만들었다. 박원갑 (person) 이 다른 entity 와 함께 "기타"
밑에 묻혀 표시됐다는 dogfood 보고가 이 픽스의 동기.

v3 fix: 10 class verbatim 1:1 + legacy `place` → `location` alias +
unknown / null fallback 만 "other".
"""
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


# v3 10 class verbatim — PO 2026-06-30 의뢰서.
V3_CLASSES = [
    # WHO
    "person",
    "organization",
    "group",
    # WHAT
    "knowledge",
    "resource",
    "task",
    "concept",
    "event",
    "metric",
    # WHERE
    "location",
]


def test_all_10_classes_route_to_dedicated_bucket():
    """★ v3 closed set 10 class 모두 자기 bucket 으로 들어간다 (★ "other"
    fallback 없음). 옛 4-bucket 시절 7 class 가 "other" 로 떨어진 비대를
    이 테스트가 회귀 가드한다."""
    from api.routes.recall import _facets_for

    # 각 class 에 한 entity 씩 시드. uid = UUID4 형식 (★ heuristic 우회).
    seeds = [
        ("11111111-1111-4111-8111-000000000001", "박원갑", "person"),
        ("11111111-1111-4111-8111-000000000002", "한국은행", "organization"),
        ("11111111-1111-4111-8111-000000000003", "KB 금융그룹", "group"),
        ("11111111-1111-4111-8111-000000000004", "Active Recall 이론", "knowledge"),
        ("11111111-1111-4111-8111-000000000005", "보고서.pdf", "resource"),
        ("11111111-1111-4111-8111-000000000006", "기준금리 인하 결정", "task"),
        ("11111111-1111-4111-8111-000000000007", "통화정책", "concept"),
        ("11111111-1111-4111-8111-000000000008", "FOMC 회의 2026Q2", "event"),
        ("11111111-1111-4111-8111-000000000009", "MAU", "metric"),
        ("11111111-1111-4111-8111-00000000000a", "서울", "location"),
    ]

    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[{"key": uid, "doc_count": idx + 1} for idx, (uid, _, _) in enumerate(seeds)],
        object_buckets=[],
        predicate_buckets=[],
    )
    client.mget.return_value = _mget_response([_doc(uid, name, cls) for uid, name, cls in seeds])

    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")

    facets = out.entities
    # ★ 10 bucket 모두 정확히 1 entity (uid 일치).
    for uid, _name, cls in seeds:
        bucket_items = getattr(facets, cls)
        assert len(bucket_items) == 1, f"class={cls}: expected 1 item, got {len(bucket_items)}"
        assert bucket_items[0].uid == uid, f"class={cls}: bucket has wrong uid"

    # ★ "other" 는 비어 있어야 한다 (★ "기타" 비대 0 가드).
    assert facets.other == [], (
        f"★ other bucket should be empty (★ M-Dogfood ⑤⑪ root cause), got: {facets.other}"
    )


def test_park_won_gap_person_not_other_regression():
    """★ M-Dogfood ⑤⑪ 회귀 가드 — 박원갑 (class=person) 은 person bucket
    에 들어가야 한다 (★ "기타" 떨어지면 안 됨). dogfood 사용자가 라이브
    환경에서 "박원갑이 기타에 묻혀 있다" 고 보고한 시나리오."""
    from api.routes.recall import _facets_for

    park_uid = "deadbeef-1111-4111-8111-000000000001"
    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[{"key": park_uid, "doc_count": 5}],
        object_buckets=[],
        predicate_buckets=[],
    )
    client.mget.return_value = _mget_response([_doc(park_uid, "박원갑", "person")])

    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")

    # ★ person bucket 에 있어야 한다.
    assert [e.name for e in out.entities.person] == ["박원갑"]
    # ★ "기타" (other) 에 없어야 한다.
    assert all(e.name != "박원갑" for e in out.entities.other), (
        "★ 박원갑 (person) leaked into 'other' bucket — M-Dogfood ⑤⑪ regressed."
    )


def test_legacy_place_routes_to_location_bucket():
    """★ pre-v3 데이터 호환 — class=place (legacy) 는 location bucket 으로
    매핑된다 (★ 옛 데이터 안전). v3 closed set 은 'location' 이지만
    pre-v3 시절 ES 에 들어간 doc 의 class 필드가 'place' 일 수 있다."""
    from api.routes.recall import _facets_for

    seoul_uid = "deadbeef-1111-4111-8111-000000000002"
    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[{"key": seoul_uid, "doc_count": 2}],
        object_buckets=[],
        predicate_buckets=[],
    )
    client.mget.return_value = _mget_response([_doc(seoul_uid, "서울", "place")])

    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")

    # ★ location bucket 에 들어간다.
    assert [e.name for e in out.entities.location] == ["서울"]
    # ★ "other" 떨어지지 않는다.
    assert out.entities.other == []


def test_unknown_class_falls_back_to_other_only():
    """★ "other" 는 unknown / null fallback 만 받는다 (★ 비대 가드).
    v3 closed set 밖의 임의 class (e.g. 옛 'service', 'product', 'artifact'
    등 pre-v3 잔재) 만 떨어진다."""
    from api.routes.recall import _facets_for

    unknown_uid = "deadbeef-1111-4111-8111-000000000003"
    client = MagicMock()
    client.search.return_value = _agg_response(
        subject_buckets=[{"key": unknown_uid, "doc_count": 1}],
        object_buckets=[],
        predicate_buckets=[],
    )
    client.mget.return_value = _mget_response([_doc(unknown_uid, "Beta SaaS", "service")])

    with patch("api.routes.recall.get_client", return_value=client):
        out = _facets_for(["fn-1"], "ks-1")

    # ★ class=service 는 v3 closed set 밖 → "other" 로 떨어짐 (★ unknown).
    assert [e.name for e in out.entities.other] == ["Beta SaaS"]
    # ★ 다른 10 bucket 은 비어 있다.
    for cls in V3_CLASSES:
        assert getattr(out.entities, cls) == [], (
            f"class=service (unknown) leaked into {cls} bucket"
        )


def test_entity_facets_schema_has_10_class_fields():
    """★ schema-level 가드 — EntityFacets pydantic model 이 v3 10 class
    + other 필드를 가진다. 새 class 추가 시 schema / aggregator / FE
    셋 다 같이 업데이트하라는 핀."""
    from api.models.recall import EntityFacets

    facets = EntityFacets()
    for cls in V3_CLASSES:
        assert hasattr(facets, cls), f"EntityFacets missing v3 class field: {cls}"
        assert getattr(facets, cls) == []
    assert hasattr(facets, "other")
    assert facets.other == []
