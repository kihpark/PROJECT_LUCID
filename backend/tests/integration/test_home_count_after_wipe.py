"""feat/entity-layer-restore — home brief cache + count source.

PO directive (2026-06-23) symptom (4): after a wipe, the nav badge
shows "검증(7)" even though the DB is empty. Discovery confirmed the
backend always returns a fresh DB+ES count; the persistent value was
a browser cache. Fix: add no-store headers.

Two tests:

  1. When all data is wiped, the brief reports facts=0 and
     is_empty=True. (Sanity that the backend itself never lies.)
  2. The HTTP response carries Cache-Control: no-store (the wire-level
     contract that prevents browser caches from serving stale).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

from api.main import app
from api.security import get_current_user


def _make_user():
    user = MagicMock()
    user.id = uuid4()
    user.email = "test@example.com"
    return user


def _make_ks(ks_id, user_id):
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user_id
    return ks


class _ZeroSession:
    """A session whose KS queries return our test KS and whose
    pending-validation count returns 0 (post-wipe state).
    """

    def __init__(self, ks):
        self._ks = ks

    def get(self, *args, **kwargs):
        return self._ks

    def query(self, *args, **kwargs):
        q = MagicMock()
        q.filter.return_value = q
        q.order_by.return_value = q
        q.first.return_value = self._ks
        q.count.return_value = 0
        return q

    def close(self):
        pass


def _zero_es_client():
    """ES client that returns 0 on every count and empty hits/aggs on
    every search — the wiped state."""
    c = MagicMock()
    c.count.return_value = {"count": 0}
    c.search.return_value = {
        "hits": {"hits": [], "total": {"value": 0}},
        "aggregations": {"top_subject": {"buckets": []}},
    }
    c.mget.return_value = {"docs": []}
    c.exists.return_value = False
    return c


def test_home_brief_reports_zero_after_wipe():
    """Backend always reads live counts. Post-wipe both Postgres and
    ES return 0; brief surfaces that."""
    user = _make_user()
    ks = _make_ks(uuid4(), user.id)
    session = _ZeroSession(ks)

    app.dependency_overrides[get_current_user] = lambda: user
    try:
        with patch(
            "api.routes.home._new_session", return_value=session,
        ), patch(
            "api.routes.home.get_client", return_value=_zero_es_client(),
        ):
            client = TestClient(app)
            resp = client.get("/api/home/brief")
        assert resp.status_code == 200
        body = resp.json()
        assert body["totals"]["facts"] == 0
        assert body["totals"]["entities"] == 0
        assert body["totals"]["sources"] == 0
        assert body["totals"]["this_week_validated"] == 0
        assert body["pending_validation"] == 0
        assert body["is_empty"] is True
    finally:
        app.dependency_overrides.clear()


def test_home_brief_sets_no_store_cache_headers():
    """The wire-level cache-defeat. Without these, a browser will
    serve the previous "검증(7)" envelope from memory and the badge
    lies after the wipe."""
    user = _make_user()
    ks = _make_ks(uuid4(), user.id)
    session = _ZeroSession(ks)

    app.dependency_overrides[get_current_user] = lambda: user
    try:
        with patch(
            "api.routes.home._new_session", return_value=session,
        ), patch(
            "api.routes.home.get_client", return_value=_zero_es_client(),
        ):
            client = TestClient(app)
            resp = client.get("/api/home/brief")
        assert resp.status_code == 200
        cc = resp.headers.get("cache-control", "")
        assert "no-store" in cc, f"expected no-store in Cache-Control, got {cc!r}"
        assert resp.headers.get("pragma") == "no-cache"
    finally:
        app.dependency_overrides.clear()
