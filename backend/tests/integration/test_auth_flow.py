"""Integration: full Sprint 1B HTTP flow against a live Postgres."""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    """Ensure JWT signing is configured for the integration suite."""
    monkeypatch.setenv("SECRET_KEY", "integration-test-secret-at-least-32-bytes-jwt")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    """FastAPI TestClient wired against a live Postgres."""
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    # Reset and reconfigure the security module's sessionmaker to use the
    # integration-test engine.
    from api.security import dependencies as sec_deps

    sec_deps._session_factory = sessionmaker(bind=pg_engine, expire_on_commit=False)

    # Also rewire the route modules' sessionmaker
    from api.routes import auth as auth_route
    from api.routes import spaces as spaces_route
    from api.routes import users as users_route
    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    auth_route._new_session = lambda: sm()
    spaces_route._new_session = lambda: sm()
    users_route._new_session = lambda: sm()

    from api.main import app
    return TestClient(app)


@pytest.fixture
def fresh_email():
    """Yield a unique email for each test (avoids collisions across runs)."""
    import uuid
    return f"user-{uuid.uuid4().hex[:8]}@lucid.example"


def test_register_creates_personal_space_and_returns_token(client, fresh_email):
    resp = client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!", "name": "Alice"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["user"]["email"] == fresh_email
    assert body["user"]["name"] == "Alice"
    assert body["space_id"]
    assert body["access_token"]
    assert body["token_type"] == "bearer"


def test_register_then_login_returns_jwt(client, fresh_email):
    client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    )
    login = client.post(
        "/api/auth/login",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    )
    assert login.status_code == 200, login.text
    body = login.json()
    assert body["access_token"]
    assert body["token_type"] == "bearer"
    assert body["expires_in"] > 0


def test_login_wrong_password_returns_401(client, fresh_email):
    client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    )
    bad = client.post(
        "/api/auth/login",
        json={"email": fresh_email, "password": "wrongpassword!"},
    )
    assert bad.status_code == 401


def test_register_conflict_on_duplicate_email(client, fresh_email):
    client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    )
    dupe = client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "anotherpassword!"},
    )
    assert dupe.status_code == 409


def test_protected_endpoint_requires_jwt(client, fresh_email):
    no_token = client.get("/api/spaces/me")
    assert no_token.status_code == 401

    reg = client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    ).json()
    headers = {"Authorization": f"Bearer {reg['access_token']}"}
    with_token = client.get("/api/spaces/me", headers=headers)
    assert with_token.status_code == 200
    spaces = with_token.json()
    assert len(spaces) == 1
    assert spaces[0]["type"] == "personal"
    assert spaces[0]["id"] == reg["space_id"]


def test_settings_get_returns_defaults_after_register(client, fresh_email):
    reg = client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    ).json()
    headers = {"Authorization": f"Bearer {reg['access_token']}"}
    settings = client.get("/api/users/me/settings", headers=headers).json()
    assert settings["validation_mode"] == "quick"
    assert settings["surface_on_by_default"] is True


def test_settings_patch_persists(client, fresh_email):
    reg = client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    ).json()
    headers = {"Authorization": f"Bearer {reg['access_token']}"}
    patched = client.patch(
        "/api/users/me/settings",
        json={"validation_mode": "strict", "surface_on_by_default": False},
        headers=headers,
    )
    assert patched.status_code == 200
    re = client.get("/api/users/me/settings", headers=headers).json()
    assert re["validation_mode"] == "strict"
    assert re["surface_on_by_default"] is False


def test_logout_with_valid_jwt_returns_204(client, fresh_email):
    reg = client.post(
        "/api/auth/register",
        json={"email": fresh_email, "password": "longerthan8chars!"},
    ).json()
    headers = {"Authorization": f"Bearer {reg['access_token']}"}
    out = client.post("/api/auth/logout", headers=headers)
    assert out.status_code == 204


def test_logout_without_jwt_returns_401(client):
    out = client.post("/api/auth/logout")
    assert out.status_code == 401
