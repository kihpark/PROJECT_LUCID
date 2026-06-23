"""Integration tests for POST /api/admin/entities/backfill-class.

Gating: require_admin must reject non-admin callers with 403.
Behavior: dry-run (apply=false) returns scanned + would-update counts
without writing. Heuristic-only mode is used so the test runs offline.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.orm import sessionmaker

from api.storage.elasticsearch.client import LUCID_OBJECTS
from api.structure import entity_reclassifier
from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "entity-backfill-test-secret-at-least-32-bytes-jwt-token-okkkkk",
    )
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")


@pytest.fixture(autouse=True)
def _mock_llm(monkeypatch):
    """Pin LLM to a deterministic abstain so no live key is needed."""
    monkeypatch.setattr(
        entity_reclassifier,
        "classify_by_llm",
        lambda name, context=None: "other",
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade, es_indexes):
    from fastapi.testclient import TestClient

    # Defensively re-ensure the indexes exist — other test files in
    # the same session (test_ensure_mappings.py) delete and recreate
    # the indexes mid-session, and their teardown ordering can leave
    # us without `lucid_objects` when our tests run.
    from api.storage.elasticsearch import indexes
    indexes.create_indexes()

    from api.security import dependencies as sec_deps

    sec_deps._session_factory = sessionmaker(
        bind=pg_engine, expire_on_commit=False,
    )

    from api.routes import admin_applications as admin_apps_route
    from api.routes import admin_entities as admin_entities_route
    from api.routes import auth as auth_route
    from api.routes import spaces as spaces_route
    from api.routes import users as users_route
    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    auth_route._new_session = lambda: sm()
    spaces_route._new_session = lambda: sm()
    users_route._new_session = lambda: sm()
    admin_apps_route._new_session = lambda: sm()
    admin_entities_route._new_session = lambda: sm()

    from api.main import app
    return TestClient(app)


def _login(client, email: str, password: str) -> str:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bootstrap_admin(client, pg_engine) -> tuple[str, str, str]:
    email = f"admin-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(
        pg_engine, email, password, is_admin=True,
    )
    token = _login(client, email, password)
    return user_id, space_id, token


def _bootstrap_nonadmin(client, pg_engine) -> tuple[str, str]:
    email = f"user-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, _space_id = create_user_via_orm(pg_engine, email, password)
    token = _login(client, email, password)
    return user_id, token


def _seed_concept_entity(es_client, ks_id: str, name: str) -> str:
    object_uid = f"obj-{uuid.uuid4().hex[:10]}"
    es_client.index(
        index=LUCID_OBJECTS,
        id=object_uid,
        document={
            "object_uid": object_uid,
            "class": "concept",
            "entity_type": None,
            "name": name,
            "primary_label": name,
            "primary_lang": "ko",
            "aliases": [],
            "properties": {},
            "fact_uids": [],
            "connected_objects": [],
            "knowledge_space_id": ks_id,
        },
        refresh="wait_for",
    )
    return object_uid


def _delete_object(es_client, doc_id: str) -> None:
    try:
        es_client.delete(
            index=LUCID_OBJECTS, id=doc_id, refresh="wait_for",
        )
    except Exception:
        pass


def test_admin_dry_run_returns_counts_without_writing(
    client, pg_engine, es_client,
):
    _admin_id, space_id, token = _bootstrap_admin(client, pg_engine)

    ids = []
    try:
        ids.append(_seed_concept_entity(es_client, space_id, "정청래"))
        ids.append(_seed_concept_entity(es_client, space_id, "더불어민주당"))

        resp = client.post(
            "/api/admin/entities/backfill-class",
            json={"ks_id": space_id, "use_llm": False, "apply": False},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["ks_id"] == space_id
        assert body["applied"] is False
        assert body["scanned"] == 2
        assert body["updated"] == 2
        assert body["by_class"].get("person") == 1
        assert body["by_class"].get("organization") == 1
        assert len(body["samples"]) == 2

        # Dry-run must NOT have written anything.
        es_client.indices.refresh(index=LUCID_OBJECTS)
        for d in ids:
            src = es_client.get(index=LUCID_OBJECTS, id=d)["_source"]
            assert src["class"] == "concept"
    finally:
        for d in ids:
            _delete_object(es_client, d)


def test_admin_apply_persists_writes(client, pg_engine, es_client):
    _admin_id, space_id, token = _bootstrap_admin(client, pg_engine)

    ids = []
    try:
        ids.append(_seed_concept_entity(es_client, space_id, "정청래"))

        resp = client.post(
            "/api/admin/entities/backfill-class",
            json={"ks_id": space_id, "use_llm": False, "apply": True},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] is True
        assert body["updated"] == 1

        es_client.indices.refresh(index=LUCID_OBJECTS)
        src = es_client.get(index=LUCID_OBJECTS, id=ids[0])["_source"]
        assert src["class"] == "person"
        assert src["entity_type"] == "person"
    finally:
        for d in ids:
            _delete_object(es_client, d)


def test_admin_backfill_resolves_default_ks(client, pg_engine, es_client):
    """When ks_id is null in the body, route resolves to admin's first KS."""
    _admin_id, space_id, token = _bootstrap_admin(client, pg_engine)

    ids = []
    try:
        ids.append(_seed_concept_entity(es_client, space_id, "정청래"))

        resp = client.post(
            "/api/admin/entities/backfill-class",
            json={"use_llm": False, "apply": False},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Should have resolved to the admin's only KS.
        assert body["ks_id"] == space_id
        assert body["scanned"] == 1
    finally:
        for d in ids:
            _delete_object(es_client, d)


def test_nonadmin_caller_gets_403(client, pg_engine):
    _user_id, token = _bootstrap_nonadmin(client, pg_engine)
    resp = client.post(
        "/api/admin/entities/backfill-class",
        json={"use_llm": False, "apply": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "admin_only"


def test_unauthenticated_gets_401(client):
    resp = client.post(
        "/api/admin/entities/backfill-class",
        json={"use_llm": False, "apply": False},
    )
    assert resp.status_code == 401
