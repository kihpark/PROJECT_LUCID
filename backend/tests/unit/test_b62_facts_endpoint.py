"""B-62 — `GET /api/spaces/{space_id}/facts` regression.

The Stellar real adapter needs to fetch every validated fact in a KS,
not just the ones that happen to match a generic seed query against
recall. This endpoint is intent-separated from recall (no semantic
weighting, no kNN, no score floor) and capped server-side.

★ acceptance criteria locked:
  - test_facts_endpoint_returns_all_validated_facts (ks-scoped, sorted)
  - test_facts_endpoint_caps_limit_at_500
  - test_facts_endpoint_excludes_retracted_facts (B-48a soft-delete)
  - test_facts_endpoint_404_on_unknown_space
  - test_facts_endpoint_403_on_other_user_space
  - test_facts_endpoint_degrades_to_empty_on_es_failure
  - test_facts_endpoint_marks_truncated_when_total_exceeds_limit
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from api.main import app


def _make_user(user_id: UUID | None = None) -> Any:
    user = MagicMock()
    user.id = user_id or uuid4()
    return user


def _make_ks(ks_id: UUID, user_id: UUID) -> Any:
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user_id
    return ks


def _session_with_ks(ks: Any) -> Any:
    """Postgres session whose `.get(KnowledgeSpace, space_id)` returns ks.
    Returns ks unconditionally — tests that need a 404 patch `get` to
    return None explicitly."""
    session = MagicMock()
    session.get.return_value = ks
    return session


def _build_es_fact_doc(
    fact_uid: str,
    *,
    knowledge_space_id: str,
    claim: str = "test claim",
    subject_uid: str = "subj-1",
    predicate: str = "supports",
    object_value: str = "obj-val",
    validated_at: str = "2026-06-20T09:00:00Z",
) -> dict[str, Any]:
    """Build an ES hit dict that satisfies the RecallFact schema."""
    return {
        "_id": fact_uid,
        "_source": {
            "fact_uid": fact_uid,
            "claim": claim,
            "subject_uid": subject_uid,
            "predicate": predicate,
            "object_value": object_value,
            "source_uids": [f"src-{fact_uid}"],
            "validated_at": validated_at,
            "validator_id": "u-1",
            "validation_method": "manual",
            "knowledge_space_id": knowledge_space_id,
            "negation_flag": False,
            "negation_scope": None,
        },
        "_score": 0.0,
    }


def _make_es_client(
    *,
    hits: list[dict[str, Any]] | None = None,
    total: int | None = None,
    raise_on_search: bool = False,
    mget_docs: list[dict[str, Any]] | None = None,
) -> Any:
    """Fake ES client. `hits` is what /facts gets; `total` overrides the
    `hits.total.value` (so we can test the `truncated` flag without
    actually building 500 facts). Set `raise_on_search` to test the
    fail-soft branch."""
    hits = hits or []
    if total is None:
        total = len(hits)
    mget_docs = mget_docs or []
    client = MagicMock()

    def _search(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        if raise_on_search:
            raise RuntimeError("es down")
        return {
            "hits": {
                "hits": list(hits),
                "total": {"value": total, "relation": "eq"},
            },
        }

    client.search.side_effect = _search
    client.mget.return_value = {"docs": list(mget_docs)}
    return client


def _override_auth(user: Any) -> None:
    """Bypass JWT validation by overriding the FastAPI dependency."""
    from api.security import get_current_user

    app.dependency_overrides[get_current_user] = lambda: user


def _clear_overrides() -> None:
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_facts_endpoint_returns_all_validated_facts():
    """★ Endpoint returns the full list of validated facts in this KS,
    sorted newest first by the ES sort directive. Each hit converts to
    a RecallFact via _hit_to_fact."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    es = _make_es_client(
        hits=[
            _build_es_fact_doc("f-1", knowledge_space_id=str(ks_id)),
            _build_es_fact_doc("f-2", knowledge_space_id=str(ks_id)),
            _build_es_fact_doc("f-3", knowledge_space_id=str(ks_id)),
        ],
    )

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["truncated"] is False
    fact_uids = [f["fact_uid"] for f in body["facts"]]
    assert fact_uids == ["f-1", "f-2", "f-3"]


def test_facts_endpoint_caps_limit_at_500():
    """★ FastAPI Query validation rejects limit > 500 — protects the
    server from a runaway client that asks for 100k facts."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    es = _make_es_client()

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts?limit=1000")
    finally:
        _clear_overrides()

    assert resp.status_code == 422  # query param validation error


def test_facts_endpoint_passes_limit_to_es_search_body():
    """★ Limit param threads through to the ES `size` field. Without
    this the `?limit=50` query string would silently use the default
    200, defeating any future pagination plan."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    seen_body: dict[str, Any] = {}

    def _capture(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        seen_body.update(body)
        return {"hits": {"hits": [], "total": {"value": 0}}}

    es = MagicMock()
    es.search.side_effect = _capture
    es.mget.return_value = {"docs": []}

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts?limit=50")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    assert seen_body.get("size") == 50


def test_facts_endpoint_es_query_excludes_retracted_facts():
    """★ The ES body must include a `must_not exists retracted_at`
    clause so soft-deleted facts (B-48a) never reach Stellar."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    seen_body: dict[str, Any] = {}

    def _capture(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        seen_body.update(body)
        return {"hits": {"hits": [], "total": {"value": 0}}}

    es = MagicMock()
    es.search.side_effect = _capture
    es.mget.return_value = {"docs": []}

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    bool_q = seen_body["query"]["bool"]
    assert "must_not" in bool_q
    assert {"exists": {"field": "retracted_at"}} in bool_q["must_not"]


def test_facts_endpoint_es_query_filters_to_ks_and_manual_only():
    """★ The ES filter pins (KS, manual). Defensive lock — without it
    auto-validated rows or other-KS rows could leak."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    seen_body: dict[str, Any] = {}

    def _capture(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        seen_body.update(body)
        return {"hits": {"hits": [], "total": {"value": 0}}}

    es = MagicMock()
    es.search.side_effect = _capture
    es.mget.return_value = {"docs": []}

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    filters = seen_body["query"]["bool"]["filter"]
    assert {"term": {"knowledge_space_id": str(ks_id)}} in filters
    assert {"term": {"validation_method": "manual"}} in filters


def test_facts_endpoint_404_on_unknown_space():
    """★ Same auth pattern as recall: unknown space → 404."""
    user = _make_user()
    session = MagicMock()
    session.get.return_value = None  # ks lookup misses

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{uuid4()}/facts")
    finally:
        _clear_overrides()

    assert resp.status_code == 404


def test_facts_endpoint_403_on_other_user_space():
    """★ Space exists but is owned by a different user → 403."""
    ks_id = uuid4()
    other_user_id = uuid4()
    user = _make_user()  # different user_id
    ks = _make_ks(ks_id, other_user_id)
    session = _session_with_ks(ks)

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts")
    finally:
        _clear_overrides()

    assert resp.status_code == 403


def test_facts_endpoint_degrades_to_empty_on_es_failure():
    """★ Fail-soft: ES throwing must NOT produce a 500. The endpoint
    returns an empty FactsList so Stellar's cold-start hint kicks in
    cleanly."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    es = _make_es_client(raise_on_search=True)

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["facts"] == []
    assert body["total"] == 0
    assert body["truncated"] is False


def test_facts_endpoint_marks_truncated_when_total_exceeds_limit():
    """★ When ES says there are more docs than we returned, the
    response carries `truncated=True` so the UI can show a hint."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    # Return 2 hits but ES says total is 50 — endpoint must flag
    # truncated even though `hits` is a small list.
    es = _make_es_client(
        hits=[
            _build_es_fact_doc("f-1", knowledge_space_id=str(ks_id)),
            _build_es_fact_doc("f-2", knowledge_space_id=str(ks_id)),
        ],
        total=50,
    )

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session), patch(
            "api.routes.recall.get_client", return_value=es,
        ):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/facts?limit=2")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2  # we returned 2
    assert body["truncated"] is True  # but ES said more existed
