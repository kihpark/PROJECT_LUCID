"""B-55 — home brief endpoint regression tests.

★ acceptance criteria locked here:
  - test_home_brief_empty_ks_returns_is_empty_true
  - test_home_brief_populated_returns_real_shape
  - test_home_brief_uses_space_id_query_param
  - test_home_brief_404_on_unknown_space
  - test_home_brief_403_on_other_user_space
  - test_home_brief_degrades_to_zero_on_es_failure
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_user(user_id: UUID | None = None) -> Any:
    user = MagicMock()
    user.id = user_id or uuid4()
    return user


def _make_ks(ks_id: UUID, user_id: UUID) -> Any:
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user_id
    return ks


def _session_with_default_ks(ks: Any) -> Any:
    """Session whose `.query(KnowledgeSpace).filter(...).order_by(...).first()`
    chain returns `ks`. `session.get` returns the same ks too (so the
    space_id path also resolves it). `query(SourceJobORM).count()` returns
    0 by default — callers patch as needed for the populated case."""
    session = MagicMock()
    session.get.return_value = ks

    chain = MagicMock()
    chain.filter.return_value = chain
    chain.order_by.return_value = chain
    chain.first.return_value = ks
    chain.count.return_value = 0
    session.query.return_value = chain
    return session


def _make_es_client(
    *,
    counts: dict[str, int] | None = None,
    search_hits: list[dict[str, Any]] | None = None,
    top_subject_buckets: list[dict[str, Any]] | None = None,
    mget_docs: list[dict[str, Any]] | None = None,
    object_get: dict[str, dict[str, Any]] | None = None,
) -> Any:
    """Build a fake ES client whose count / search / mget / get / exists
    return whatever the test wires up. `counts` maps index name → count.
    `search_hits` is the list returned for the recent_validated search.
    `top_subject_buckets` is the buckets list for the terms agg search.
    `mget_docs` is the response for the subject label mget.
    `object_get` maps uid → source-dict for the cluster name lookup."""
    counts = counts or {}
    search_hits = search_hits or []
    top_subject_buckets = top_subject_buckets or []
    mget_docs = mget_docs or []
    object_get = object_get or {}

    client = MagicMock()

    def _count(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return {"count": counts.get(index, 0)}

    client.count.side_effect = _count

    def _search(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        if "aggs" in body:
            return {
                "aggregations": {
                    "top_subject": {"buckets": list(top_subject_buckets)},
                },
                "hits": {"hits": []},
            }
        return {"hits": {"hits": list(search_hits)}}

    client.search.side_effect = _search

    def _mget(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        return {"docs": list(mget_docs)}

    client.mget.side_effect = _mget

    def _exists(*, index: str, id: str) -> bool:
        return id in object_get

    client.exists.side_effect = _exists

    def _get(*, index: str, id: str) -> dict[str, Any]:
        return {"_source": object_get[id]}

    client.get.side_effect = _get
    return client


# ---------------------------------------------------------------------------
# A. Empty KS — every counter zero, is_empty=True
# ---------------------------------------------------------------------------

def test_home_brief_empty_ks_returns_is_empty_true():
    """★ A fresh KS with no facts surfaces an empty envelope: every
    counter zero, recent_validated empty, top_cluster all-null,
    is_empty=True."""
    from api.routes.home import home_brief

    user = _make_user()
    ks = _make_ks(uuid4(), user.id)
    session = _session_with_default_ks(ks)

    fake_client = _make_es_client()  # zero on everything

    with patch(
        "api.routes.home._new_session", return_value=session,
    ), patch(
        "api.routes.home.get_client", return_value=fake_client,
    ):
        result = home_brief(space_id=None, user=user)

    assert result.is_empty is True
    assert result.totals.facts == 0
    assert result.totals.entities == 0
    assert result.totals.sources == 0
    assert result.totals.this_week_validated == 0
    assert result.pending_validation == 0
    assert result.recent_validated == []
    assert result.top_cluster.entity_uid is None
    assert result.top_cluster.entity_name is None
    assert result.top_cluster.linked_count == 0


# ---------------------------------------------------------------------------
# B. Populated KS — every field carries its real value
# ---------------------------------------------------------------------------

def test_home_brief_populated_returns_real_shape():
    """★ Populated KS: facts=42, entities=12, sources=7, this_week=5,
    pending=3, top_cluster=SpaceX with linked_count=8, and 5 recent rows
    each carrying a resolved subject_label."""
    from api.routes.home import home_brief
    from api.storage.elasticsearch.client import (
        LUCID_FACTS,
        LUCID_OBJECTS,
        LUCID_SOURCES,
    )

    user = _make_user()
    ks = _make_ks(uuid4(), user.id)
    session = _session_with_default_ks(ks)

    # pending_validation = 3 — wire the SourceJobORM chain.
    session.query.return_value.count.return_value = 3

    # Five recent facts, each referencing a known subject so the label
    # mget can paint them.
    recent_hits = [
        {
            "_source": {
                "fact_uid": f"fact-{i}",
                "claim": f"claim {i}",
                "subject_uid": f"uid-{i}",
                "validated_at": f"2026-06-1{i}T09:00:00Z",
            },
            "_id": f"fact-{i}",
        }
        for i in range(1, 6)
    ]
    mget_docs = [
        {
            "_id": f"uid-{i}",
            "found": True,
            "_source": {
                "object_uid": f"uid-{i}",
                "name": f"Entity {i}",
                "knowledge_space_id": str(ks.id),
            },
        }
        for i in range(1, 6)
    ]

    top_buckets = [{"key": "uid-spacex", "doc_count": 8}]
    object_get = {
        "uid-spacex": {
            "object_uid": "uid-spacex",
            "name": "SpaceX",
            "class": "organization",
            "knowledge_space_id": str(ks.id),
        },
    }

    # The _this_week_count call also hits LUCID_FACTS. We override the
    # count side_effect to distinguish manual all-time (42) from the
    # 7-day window (5) by detecting the date range clause in `body`.
    fake_client = _make_es_client(
        search_hits=recent_hits,
        top_subject_buckets=top_buckets,
        mget_docs=mget_docs,
        object_get=object_get,
    )

    def _count(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        if index == LUCID_FACTS:
            # detect range clause in filters list
            filters = body["query"]["bool"]["filter"]
            has_range = any("range" in f for f in filters)
            return {"count": 5 if has_range else 42}
        if index == LUCID_OBJECTS:
            return {"count": 12}
        if index == LUCID_SOURCES:
            return {"count": 7}
        return {"count": 0}

    fake_client.count.side_effect = _count

    with patch(
        "api.routes.home._new_session", return_value=session,
    ), patch(
        "api.routes.home.get_client", return_value=fake_client,
    ):
        result = home_brief(space_id=None, user=user)

    assert result.is_empty is False
    assert result.totals.facts == 42
    assert result.totals.entities == 12
    assert result.totals.sources == 7
    assert result.totals.this_week_validated == 5
    assert result.pending_validation == 3

    assert result.top_cluster.entity_uid == "uid-spacex"
    assert result.top_cluster.entity_name == "SpaceX"
    assert result.top_cluster.linked_count == 8

    assert len(result.recent_validated) == 5
    # Each recent row carried the resolved label, not the raw uid.
    labels = {r.fact_uid: r.subject_label for r in result.recent_validated}
    assert labels == {f"fact-{i}": f"Entity {i}" for i in range(1, 6)}


# ---------------------------------------------------------------------------
# C. space_id query param overrides the default KS
# ---------------------------------------------------------------------------

def test_home_brief_uses_space_id_query_param():
    """★ When the caller passes ?space_id=… the resolution uses
    session.get(KnowledgeSpace, that_id), NOT the user's default
    (the .query / .order_by / .first chain is not consulted)."""
    from api.routes.home import home_brief

    user = _make_user()
    target_ks_id = uuid4()
    target_ks = _make_ks(target_ks_id, user.id)
    # A *different* KS sits in the default chain — proving the query
    # param wins.
    default_ks = _make_ks(uuid4(), user.id)

    session = MagicMock()

    def _get(model: Any, key: UUID) -> Any:
        if key == target_ks_id:
            return target_ks
        return None

    session.get.side_effect = _get

    chain = MagicMock()
    chain.filter.return_value = chain
    chain.order_by.return_value = chain
    chain.first.return_value = default_ks
    chain.count.return_value = 0
    session.query.return_value = chain

    fake_client = _make_es_client()

    with patch(
        "api.routes.home._new_session", return_value=session,
    ), patch(
        "api.routes.home.get_client", return_value=fake_client,
    ):
        result = home_brief(space_id=target_ks_id, user=user)

    # Sanity: result rendered against target_ks (counters zero — empty),
    # and the default-chain was NOT consulted (first() never called).
    assert result.is_empty is True
    assert chain.first.call_count == 0
    # session.get was called with the target uuid.
    called_with = [c.args[1] for c in session.get.call_args_list]
    assert target_ks_id in called_with


# ---------------------------------------------------------------------------
# D. 404 on unknown space
# ---------------------------------------------------------------------------

def test_home_brief_404_on_unknown_space():
    """When ?space_id resolves to a missing KS the route raises 404,
    matching /api/spaces/{space_id}/recall behaviour."""
    from fastapi import HTTPException

    from api.routes.home import home_brief

    user = _make_user()
    session = MagicMock()
    session.get.return_value = None

    with patch(
        "api.routes.home._new_session", return_value=session,
    ):
        with pytest.raises(HTTPException) as exc:
            home_brief(space_id=uuid4(), user=user)

    assert exc.value.status_code == 404


def test_home_brief_403_on_other_user_space():
    """A KS that exists but belongs to a different user → 403."""
    from fastapi import HTTPException

    from api.routes.home import home_brief

    user = _make_user()
    other_user = _make_user()
    foreign_ks_id = uuid4()
    foreign_ks = _make_ks(foreign_ks_id, other_user.id)

    session = MagicMock()
    session.get.return_value = foreign_ks

    with patch(
        "api.routes.home._new_session", return_value=session,
    ):
        with pytest.raises(HTTPException) as exc:
            home_brief(space_id=foreign_ks_id, user=user)

    assert exc.value.status_code == 403


# ---------------------------------------------------------------------------
# E. ES outage degrades to zeros — never a 500
# ---------------------------------------------------------------------------

def test_home_brief_degrades_to_zero_on_es_failure():
    """★ When every ES call raises, the response shape is preserved:
    counters zero, recent empty, cluster null, is_empty=True. No 500."""
    from api.routes.home import home_brief

    user = _make_user()
    ks = _make_ks(uuid4(), user.id)
    session = _session_with_default_ks(ks)

    fake_client = MagicMock()
    fake_client.count.side_effect = RuntimeError("ES down")
    fake_client.search.side_effect = RuntimeError("ES down")
    fake_client.mget.side_effect = RuntimeError("ES down")
    fake_client.exists.side_effect = RuntimeError("ES down")
    fake_client.get.side_effect = RuntimeError("ES down")

    with patch(
        "api.routes.home._new_session", return_value=session,
    ), patch(
        "api.routes.home.get_client", return_value=fake_client,
    ):
        result = home_brief(space_id=None, user=user)

    assert result.is_empty is True
    assert result.totals.facts == 0
    assert result.totals.entities == 0
    assert result.totals.sources == 0
    assert result.totals.this_week_validated == 0
    # Postgres is healthy in this case → pending count from the mock = 0.
    assert result.pending_validation == 0
    assert result.recent_validated == []
    assert result.top_cluster.entity_uid is None
    assert result.top_cluster.entity_name is None
    assert result.top_cluster.linked_count == 0
