"""B-61 — integration tests for GET /api/auth/me.

Covers the three pinned contracts:
  - /me after login returns identity + is_new_user=True + the
    just-created personal space id as default_space_id.
  - /me without an Authorization header returns 401.
  - /me with a token that was already "logged out" returns 200 anyway
    because the JWT is stateless — there is no server-side denylist
    in beta. The test pins this so a later phase change (denylist) is
    a visible diff, not a silent behaviour drift.

B-61-fix-admission: user creation is done directly via the ORM (no
public /register endpoint exists anymore — admins admit users via
/api/admin/applications/{id}/approve).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "b61-me-test-secret-at-least-32-bytes-jwt-12345",
    )
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    from fastapi.testclient import TestClient

    from api.security import dependencies as sec_deps

    sec_deps._session_factory = sessionmaker(
        bind=pg_engine, expire_on_commit=False,
    )

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
    return f"b61-{uuid.uuid4().hex[:8]}@lucid.example"


def _create_user_via_orm(
    pg_engine, email: str, password: str, name: str | None = None,
) -> tuple[str, str]:
    """Create a User + Personal KnowledgeSpace + UserSettings directly
    via the ORM. Returns (user_id, space_id). Replaces the deleted
    /api/auth/register path for tests that need a bootstrapped user.
    """
    from api.security import hash_password
    from api.storage.postgres.orm import KnowledgeSpace, User, UserSettings

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    session = sm()
    try:
        user = User(
            email=email,
            name=name,
            password_hash=hash_password(password),
        )
        session.add(user)
        session.flush()
        space = KnowledgeSpace(
            user_id=user.id, type="personal", name=name or "Personal",
        )
        session.add(space)
        settings = UserSettings(
            user_id=user.id,
            validation_mode="quick",
            surface_on_by_default=True,
        )
        session.add(settings)
        session.commit()
        session.refresh(user)
        session.refresh(space)
        return str(user.id), str(space.id)
    finally:
        session.close()


def test_b61_me_returns_identity_after_login(client, fresh_email, pg_engine):
    """Bootstrap user via ORM → login → /me returns email, display_name,
    default_space_id, and is_new_user=True (no facts yet)."""
    password = "longerthan8chars!"
    user_id, space_id = _create_user_via_orm(
        pg_engine, fresh_email, password, name="Test User",
    )

    login = client.post(
        "/api/auth/login",
        json={"email": fresh_email, "password": password},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]

    me_resp = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_resp.status_code == 200, me_resp.text
    me = me_resp.json()
    assert me["email"] == fresh_email
    assert me["display_name"] == "Test User"
    assert me["default_space_id"] == space_id
    # Just created with no captured facts → cold-start.
    assert me["is_new_user"] is True
    assert me["user_id"] == user_id
    # B-61-fix-admission: is_admin contract is exposed.
    assert me["is_admin"] is False


def test_b61_me_returns_401_without_token(client):
    """/me without an Authorization header → 401."""
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401


def test_b61_me_returns_200_after_logout_because_jwt_is_stateless(
    client, fresh_email, pg_engine,
):
    """Bootstrap user → login → logout (server-side stateless) → /me
    with the same token still returns 200. This is intentional: JWT has
    no server-side revocation in beta. If a denylist lands in Phase 1+
    this test flips to expect 401 — making the behaviour change
    visible as a diff rather than a silent drift.
    """
    password = "longerthan8chars!"
    _create_user_via_orm(pg_engine, fresh_email, password)

    login = client.post(
        "/api/auth/login",
        json={"email": fresh_email, "password": password},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    out = client.post("/api/auth/logout", headers=headers)
    assert out.status_code == 204

    me_resp = client.get("/api/auth/me", headers=headers)
    assert me_resp.status_code == 200, (
        "stateless JWT — logout is client-side; the token stays valid "
        "until natural expiry. Flip this assertion if/when a denylist "
        "lands in Phase 1+."
    )


def test_b61_me_default_space_is_first_personal_space(
    client, fresh_email, pg_engine,
):
    """When the user has one personal space, default_space_id is that
    space — and it is the same id that the ORM bootstrap returned."""
    password = "longerthan8chars!"
    _user_id, space_id = _create_user_via_orm(
        pg_engine, fresh_email, password,
    )

    login = client.post(
        "/api/auth/login",
        json={"email": fresh_email, "password": password},
    )
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    me = client.get("/api/auth/me", headers=headers).json()
    spaces = client.get("/api/spaces/me", headers=headers).json()
    personal_ids = [s["id"] for s in spaces if s["type"] == "personal"]
    assert me["default_space_id"] in personal_ids
    assert me["default_space_id"] == space_id
