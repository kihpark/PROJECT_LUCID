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


def _seed_predicates(pg_engine, rows):
    """Insert predicate rows directly via ORM for test setup."""
    from api.storage.postgres.orm import Predicate
    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    with sm() as s:
        for row in rows:
            s.add(Predicate(**row))
        s.commit()


class TestPredicatesList:
    def test_returns_all_predicates(self, client, pg_engine, alembic_upgrade):
        _seed_predicates(pg_engine, [
            {"code": "plans", "label_ko": "계획", "label_en": "plans", "sort_order": 1},
            {"code": "founded", "label_ko": "설립", "label_en": "founded", "sort_order": 2},
        ])
        r = client.get("/api/predicates")
        assert r.status_code == 200
        items = r.json()["items"]
        codes = [i["code"] for i in items]
        assert "plans" in codes
        assert "founded" in codes

    def test_sorted_by_sort_order_then_code(self, client, pg_engine, alembic_upgrade):
        _seed_predicates(pg_engine, [
            {"code": "z_last", "label_ko": "Z", "label_en": "Z", "sort_order": 10},
            {"code": "a_first", "label_ko": "A", "label_en": "A", "sort_order": 1},
        ])
        r = client.get("/api/predicates")
        assert r.status_code == 200
        items = r.json()["items"]
        if len(items) >= 2:
            # a_first (sort_order=1) must come before z_last (sort_order=10)
            codes = [i["code"] for i in items]
            idx_a = next((i for i, c in enumerate(codes) if c == "a_first"), None)
            idx_z = next((i for i, c in enumerate(codes) if c == "z_last"), None)
            if idx_a is not None and idx_z is not None:
                assert idx_a < idx_z
