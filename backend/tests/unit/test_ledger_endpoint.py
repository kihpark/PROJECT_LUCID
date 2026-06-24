"""feat/ledger-view — `GET /api/spaces/{space_id}/ledger` regression.

The LEDGER endpoint is the chronological "list of recently validated
facts" surface — the third view alongside DECIDE (validation queue,
pre-validation) and RECALL (search). Same auth + KS pinning as the
other recall.py endpoints; the new ground covered here is:

  - sort = validated_at desc (with _id tie-break)
  - limit + offset pagination (default 20, max 100)
  - optional fact_type chip filter
  - LedgerItem projection drops score/match_kind/etc.
  - fail-soft to an empty envelope on ES failure

Acceptance lock — at least 8 cases covering the full surface.
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
    fact_type: str | None = None,
) -> dict[str, Any]:
    source: dict[str, Any] = {
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
    }
    if fact_type is not None:
        source["fact_type"] = fact_type
    return {"_id": fact_uid, "_source": source, "_score": 0.0}


def _make_es_client(
    *,
    hits: list[dict[str, Any]] | None = None,
    total: int | None = None,
    raise_on_search: bool = False,
    mget_docs: list[dict[str, Any]] | None = None,
) -> Any:
    """Fake ES client. Mirrors the test_b62 helper."""
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
    from api.security import get_current_user

    app.dependency_overrides[get_current_user] = lambda: user


def _clear_overrides() -> None:
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_ledger_returns_validated_facts_time_desc():
    """★ Filled case — three facts come back projected to LedgerItem and
    the ES body asks for sort by validated_at desc."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    seen_body: dict[str, Any] = {}

    def _capture(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        seen_body.update(body)
        return {
            "hits": {
                "hits": [
                    _build_es_fact_doc(
                        "f-3",
                        knowledge_space_id=str(ks_id),
                        validated_at="2026-06-22T09:00:00Z",
                    ),
                    _build_es_fact_doc(
                        "f-2",
                        knowledge_space_id=str(ks_id),
                        validated_at="2026-06-21T09:00:00Z",
                    ),
                    _build_es_fact_doc(
                        "f-1",
                        knowledge_space_id=str(ks_id),
                        validated_at="2026-06-20T09:00:00Z",
                    ),
                ],
                "total": {"value": 3},
            },
        }

    es = MagicMock()
    es.search.side_effect = _capture
    es.mget.return_value = {"docs": []}

    _override_auth(user)
    try:
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["limit"] == 20
    assert body["offset"] == 0
    fact_uids = [f["fact_uid"] for f in body["facts"]]
    assert fact_uids == ["f-3", "f-2", "f-1"]
    # Sort directive on the ES body — validated_at desc, _id tiebreak.
    sort = seen_body.get("sort")
    assert isinstance(sort, list)
    assert sort[0] == {"validated_at": {"order": "desc"}}
    # LedgerItem must NOT carry score / match_kind / contradiction_count.
    sample = body["facts"][0]
    assert "score" not in sample
    assert "match_kind" not in sample
    assert "validation_method" not in sample
    assert "validator_id" not in sample


def test_ledger_empty_ks_returns_empty_envelope():
    """★ Zero hits → empty facts list, total 0, echo limit/offset."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    es = _make_es_client(hits=[])

    _override_auth(user)
    try:
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["facts"] == []
    assert body["total"] == 0
    assert body["limit"] == 20
    assert body["offset"] == 0


def test_ledger_pagination_passes_limit_and_offset_to_es():
    """★ ?limit=N&offset=M threads through to ES `size` / `from`."""
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
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger?limit=10&offset=40")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    assert seen_body.get("size") == 10
    assert seen_body.get("from") == 40
    body = resp.json()
    assert body["limit"] == 10
    assert body["offset"] == 40


def test_ledger_filters_by_fact_type():
    """★ ?fact_type=claim adds a term filter on the ES body."""
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
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(
                f"/api/spaces/{ks_id}/ledger?fact_type=claim",
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    filters = seen_body["query"]["bool"]["filter"]
    assert {"term": {"fact_type": "claim"}} in filters


def test_ledger_es_query_filters_to_ks_and_manual_only():
    """★ Defensive lock: the filter pins (KS, manual) and excludes
    retracted facts via must_not. Same guarantee as /facts."""
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
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    bool_q = seen_body["query"]["bool"]
    filters = bool_q["filter"]
    assert {"term": {"knowledge_space_id": str(ks_id)}} in filters
    assert {"term": {"validation_method": "manual"}} in filters
    assert {"exists": {"field": "retracted_at"}} in bool_q["must_not"]


def test_ledger_404_on_unknown_space():
    """★ Standard auth pattern: unknown space → 404."""
    user = _make_user()
    session = MagicMock()
    session.get.return_value = None

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{uuid4()}/ledger")
    finally:
        _clear_overrides()

    assert resp.status_code == 404


def test_ledger_403_on_other_user_space():
    """★ Space exists, owned by a different user → 403."""
    ks_id = uuid4()
    other_user_id = uuid4()
    user = _make_user()  # different user_id
    ks = _make_ks(ks_id, other_user_id)
    session = _session_with_ks(ks)

    _override_auth(user)
    try:
        with patch("api.routes.recall._new_session", return_value=session):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger")
    finally:
        _clear_overrides()

    assert resp.status_code == 403


def test_ledger_degrades_to_empty_on_es_failure():
    """★ Fail-soft: ES throwing produces an empty envelope, not a 500.
    The FE then renders the empty-state CTA (link to /pending)."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    es = _make_es_client(raise_on_search=True)

    _override_auth(user)
    try:
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger")
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["facts"] == []
    assert body["total"] == 0
    assert body["limit"] == 20
    assert body["offset"] == 0


def test_ledger_caps_limit_at_100():
    """★ FastAPI Query validation rejects limit > 100 — protects against
    a runaway client asking for the whole KS in one page."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_with_ks(ks)
    es = _make_es_client()

    _override_auth(user)
    try:
        with patch(
            "api.routes.recall._new_session", return_value=session,
        ), patch("api.routes.recall.get_client", return_value=es):
            client = TestClient(app)
            resp = client.get(f"/api/spaces/{ks_id}/ledger?limit=500")
    finally:
        _clear_overrides()

    assert resp.status_code == 422  # query param validation error
