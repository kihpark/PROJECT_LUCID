"""Integration tests — entity suggestion endpoint (spo-pending-ux).

Tests GET /api/spaces/{space_id}/entities/suggest?q=<partial>
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.orm import sessionmaker

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "entities-suggest-test-secret-at-least-32-chars-long",
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    from fastapi.testclient import TestClient

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    from api.security import dependencies as sec_deps
    sec_deps._session_factory = sm
    from api.routes import auth as auth_route
    from api.routes import entities as ent_route
    from api.routes import spaces as sp_route

    for mod in (auth_route, sp_route, ent_route):
        mod._new_session = lambda sm=sm: sm()

    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_ctx(client, pg_engine):
    email = f"ent-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    return headers, user_id, space_id


def _index_object(space_id: str, name: str, name_en: str = "", uid: str | None = None):
    """Index an object document directly into lucid_objects ES index."""
    from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
    doc_id = uid or str(uuid.uuid4())
    client = get_client()
    client.index(
        index=LUCID_OBJECTS,
        id=doc_id,
        document={
            "object_uid": doc_id,
            "name": name,
            "name_en": name_en or name,
            "aliases": [],
            "knowledge_space_id": space_id,
            "class": "organization",
        },
        refresh="wait_for",
    )
    return doc_id


class TestEntitiesSuggest:
    def test_returns_empty_when_no_entities(self, client, auth_ctx):
        headers, _uid, space_id = auth_ctx
        r = client.get(
            f"/api/spaces/{space_id}/entities/suggest?q=anything",
            headers=headers,
        )
        assert r.status_code == 200
        assert r.json()["items"] == []

    def test_matches_by_exact_name(self, client, auth_ctx):
        headers, _uid, space_id = auth_ctx
        _index_object(space_id, "SpaceX", "SpaceX")
        r = client.get(
            f"/api/spaces/{space_id}/entities/suggest?q=SpaceX",
            headers=headers,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1
        assert any(i["primary_label"] == "SpaceX" for i in items)

    def test_matches_by_prefix(self, client, auth_ctx):
        headers, _uid, space_id = auth_ctx
        _index_object(space_id, "Goldman Sachs", "Goldman Sachs")
        r = client.get(
            f"/api/spaces/{space_id}/entities/suggest?q=Gold",
            headers=headers,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert any("Goldman" in i["primary_label"] for i in items)

    def test_matches_by_name_en(self, client, auth_ctx):
        headers, _uid, space_id = auth_ctx
        _index_object(space_id, "서울외환시장운영협의회", "Seoul FX Market")
        r = client.get(
            f"/api/spaces/{space_id}/entities/suggest?q=Seoul",
            headers=headers,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        # name is the primary_label (not name_en), but the match must fire
        assert len(items) >= 1

    def test_other_space_entities_not_included(self, client, auth_ctx, pg_engine):
        headers, _uid, space_id = auth_ctx
        # Create a second space with a different user
        other_space_id = str(uuid.uuid4())
        _index_object(other_space_id, "OtherSpaceEntity", "OtherSpaceEntity")
        r = client.get(
            f"/api/spaces/{space_id}/entities/suggest?q=OtherSpaceEntity",
            headers=headers,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert not any(i["primary_label"] == "OtherSpaceEntity" for i in items)
