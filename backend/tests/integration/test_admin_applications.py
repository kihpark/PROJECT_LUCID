"""B-61-fix-admission — integration tests for the admin admission flow.

GET  /api/admin/applications              — list (pending|approved|rejected|all)
POST /api/admin/applications/{id}/approve — admit, create User + KS + settings

All endpoints gate on `require_admin`. Non-admin / unauthenticated callers
get 403 / 401 respectively. The approve path is idempotent: re-hitting an
already-approved application returns the existing user without issuing a
fresh temp password.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import sessionmaker

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "b61-admin-admission-test-secret-at-least-32-bytes-jwt-1234",
    )
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")


@pytest.fixture
def client(pg_engine, alembic_upgrade, es_indexes):
    from fastapi.testclient import TestClient

    from api.security import dependencies as sec_deps

    sec_deps._session_factory = sessionmaker(
        bind=pg_engine, expire_on_commit=False,
    )

    from api.routes import admin_applications as admin_route
    from api.routes import auth as auth_route
    from api.routes import spaces as spaces_route
    from api.routes import users as users_route
    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    auth_route._new_session = lambda: sm()
    spaces_route._new_session = lambda: sm()
    users_route._new_session = lambda: sm()
    admin_route._new_session = lambda: sm()

    from api.main import app
    return TestClient(app)


def _login(client, email: str, password: str) -> str:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _bootstrap_admin(client, pg_engine) -> tuple[str, str]:
    """Create an admin user via ORM + log them in. Returns (user_id, token)."""
    email = f"admin-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, _space_id = create_user_via_orm(
        pg_engine, email, password, is_admin=True,
    )
    token = _login(client, email, password)
    return user_id, token


def _bootstrap_nonadmin(client, pg_engine) -> tuple[str, str]:
    email = f"user-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, _space_id = create_user_via_orm(pg_engine, email, password)
    token = _login(client, email, password)
    return user_id, token


def _seed_application(
    es_client,
    *,
    email: str,
    status_value: str = "pending",
    application_id: str | None = None,
) -> str:
    from api.storage.elasticsearch.client import LUCID_APPLICATIONS
    app_id = application_id or f"app-{uuid.uuid4().hex[:10]}"
    doc = {
        "application_id": app_id,
        "email": email,
        "email_lower": email.lower(),
        "profession": "researcher",
        "q1": "I bookmark links but lose context.",
        "q2": "I cited a stat I cannot relocate.",
        "lang": "ko",
        "source": "landing-v82",
        "status": status_value,
        "created_at": datetime.now(UTC).isoformat(),
    }
    es_client.index(
        index=LUCID_APPLICATIONS, id=app_id, document=doc, refresh="wait_for",
    )
    return app_id


def _delete_application(es_client, application_id: str) -> None:
    from api.storage.elasticsearch.client import LUCID_APPLICATIONS
    try:
        es_client.delete(
            index=LUCID_APPLICATIONS, id=application_id, refresh="wait_for",
        )
    except Exception:
        pass


def _count_users(pg_engine) -> int:
    from sqlalchemy import func, select

    from api.storage.postgres.orm import User
    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    session = sm()
    try:
        return session.scalar(select(func.count()).select_from(User)) or 0
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_list_as_admin_returns_items(client, pg_engine, es_client):
    _admin_id, token = _bootstrap_admin(client, pg_engine)

    a1 = _seed_application(es_client, email=f"p1-{uuid.uuid4().hex[:6]}@x.com")
    a2 = _seed_application(es_client, email=f"p2-{uuid.uuid4().hex[:6]}@x.com")
    a3 = _seed_application(
        es_client,
        email=f"a1-{uuid.uuid4().hex[:6]}@x.com",
        status_value="approved",
    )
    try:
        resp = client.get(
            "/api/admin/applications?status=pending",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        ids = {item["application_id"] for item in body["items"]}
        assert a1 in ids
        assert a2 in ids
        assert a3 not in ids
    finally:
        for app_id in (a1, a2, a3):
            _delete_application(es_client, app_id)


def test_list_as_non_admin_returns_403(client, pg_engine):
    _user_id, token = _bootstrap_nonadmin(client, pg_engine)
    resp = client.get(
        "/api/admin/applications",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "admin_only"


def test_list_unauthenticated_returns_401(client):
    resp = client.get("/api/admin/applications")
    assert resp.status_code == 401


def test_approve_pending_creates_user_and_returns_temp_password(
    client, pg_engine, es_client,
):
    _admin_id, token = _bootstrap_admin(client, pg_engine)
    email = f"new-{uuid.uuid4().hex[:8]}@example.com"
    app_id = _seed_application(es_client, email=email)
    try:
        before = _count_users(pg_engine)
        resp = client.post(
            f"/api/admin/applications/{app_id}/approve",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["application_id"] == app_id
        assert body["email"] == email
        assert body["temp_password"], "temp_password must be non-empty"
        assert body["already_existed"] is False
        assert body["status"] == "approved"

        # User + Personal KnowledgeSpace + UserSettings created.
        from sqlalchemy import select

        from api.storage.postgres.orm import (
            KnowledgeSpace,
            User,
            UserSettings,
        )
        sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
        session = sm()
        try:
            user = session.scalar(select(User).where(User.email == email))
            assert user is not None
            assert user.password_hash
            ks = session.scalar(
                select(KnowledgeSpace).where(
                    KnowledgeSpace.user_id == user.id,
                ),
            )
            assert ks is not None
            assert ks.type == "personal"
            settings = session.scalar(
                select(UserSettings).where(UserSettings.user_id == user.id),
            )
            assert settings is not None
            assert settings.validation_mode == "quick"
        finally:
            session.close()

        # ES status now "approved".
        from api.storage.elasticsearch.client import LUCID_APPLICATIONS
        doc = es_client.get(index=LUCID_APPLICATIONS, id=app_id)
        assert doc["_source"]["status"] == "approved"

        after = _count_users(pg_engine)
        assert after == before + 1
    finally:
        _delete_application(es_client, app_id)


def test_approve_as_non_admin_returns_403(client, pg_engine, es_client):
    _user_id, token = _bootstrap_nonadmin(client, pg_engine)
    email = f"target-{uuid.uuid4().hex[:8]}@example.com"
    app_id = _seed_application(es_client, email=email)
    try:
        resp = client.post(
            f"/api/admin/applications/{app_id}/approve",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "admin_only"
    finally:
        _delete_application(es_client, app_id)


def test_approve_already_approved_is_graceful(client, pg_engine, es_client):
    _admin_id, token = _bootstrap_admin(client, pg_engine)
    email = f"already-{uuid.uuid4().hex[:8]}@example.com"
    # Bootstrap a User row so the "current user count" stays stable.
    create_user_via_orm(pg_engine, email, "longerthan8chars!")
    # Seed an already-approved application for this user.
    app_id = _seed_application(es_client, email=email, status_value="approved")
    try:
        before = _count_users(pg_engine)
        resp = client.post(
            f"/api/admin/applications/{app_id}/approve",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["temp_password"] == ""
        assert body["already_existed"] is True
        assert body["status"] == "approved"

        after = _count_users(pg_engine)
        assert after == before, "no new User row should be created"
    finally:
        _delete_application(es_client, app_id)


def test_approve_when_user_already_exists_marks_approved_no_new_password(
    client, pg_engine, es_client,
):
    _admin_id, token = _bootstrap_admin(client, pg_engine)
    email = f"existing-{uuid.uuid4().hex[:8]}@example.com"
    create_user_via_orm(pg_engine, email, "longerthan8chars!")
    app_id = _seed_application(es_client, email=email, status_value="pending")
    try:
        before = _count_users(pg_engine)
        resp = client.post(
            f"/api/admin/applications/{app_id}/approve",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["already_existed"] is True
        assert body["temp_password"] == ""
        assert body["status"] == "approved"

        from api.storage.elasticsearch.client import LUCID_APPLICATIONS
        doc = es_client.get(index=LUCID_APPLICATIONS, id=app_id)
        assert doc["_source"]["status"] == "approved"

        after = _count_users(pg_engine)
        assert after == before, "User existed already; no new row"
    finally:
        _delete_application(es_client, app_id)


def test_approve_nonexistent_application_returns_404(client, pg_engine):
    _admin_id, token = _bootstrap_admin(client, pg_engine)
    bogus = f"app-{uuid.uuid4().hex}"
    resp = client.post(
        f"/api/admin/applications/{bogus}/approve",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404, resp.text
