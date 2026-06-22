"""Integration tests — predicates list endpoint (spo-pending-ux).

Tests GET /api/predicates
"""
from __future__ import annotations

import pytest
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "predicates-list-test-secret-at-least-32-chars-long",
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    from fastapi.testclient import TestClient

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    from api.routes import predicates as pred_route
    pred_route._new_session = lambda sm=sm: sm()

    from api.main import app
    return TestClient(app)


class TestPredicatesList:
    def test_returns_bedrock_predicates(self, client):
        """Alembic migrations 0015 + 0016 seed the OPL vocabulary; the
        endpoint must surface them so the FactCard predicate
        autocomplete has data on first paint."""
        r = client.get("/api/predicates")
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 10  # 0015 seeds 10, 0016 expands to 30
        # Every entry has the three required fields
        for it in items:
            assert isinstance(it["code"], str) and it["code"]
            assert isinstance(it["label_ko"], str) and it["label_ko"]
            assert isinstance(it["label_en"], str) and it["label_en"]

    def test_sorted_by_sort_order_then_code(self, client):
        """The endpoint returns rows ordered by (sort_order, code)."""
        r = client.get("/api/predicates")
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 2
        # Items must already be in non-decreasing sort_order. Since the
        # response model omits sort_order, we re-query the bedrock rows
        # from the test DB and verify order alignment.
        from api.storage.postgres.orm import Predicate
        from sqlalchemy.orm import sessionmaker
        from api.storage.postgres.session import make_sessionmaker
        sm = make_sessionmaker()
        with sm() as s:
            db_rows = s.query(Predicate).order_by(
                Predicate.sort_order, Predicate.code,
            ).all()
        endpoint_codes = [i["code"] for i in items]
        db_codes = [r.code for r in db_rows]
        assert endpoint_codes == db_codes

    def test_no_auth_required(self, client):
        """Predicates endpoint is public (no auth header) — used by the
        FactCard predicate autocomplete which loads on initial render."""
        r = client.get("/api/predicates")
        assert r.status_code == 200
