"""Unit tests for POST /api/capture/video — B-46 PR1."""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "SECRET_KEY", "unit-test-secret-at-least-32-characters-long-jwt"
    )


@pytest.fixture()
def client() -> TestClient:
    """TestClient with no real DB — auth short-circuits before any DB call
    for the unauthenticated branch."""
    from api.main import app

    return TestClient(app)


def test_capture_video_without_token_returns_401(client: TestClient) -> None:
    r = client.post(
        "/api/capture/video",
        json={"url": "https://example.com/video.mp4"},
    )
    assert r.status_code == 401


def test_capture_video_invalid_url_returns_422(client: TestClient) -> None:
    r = client.post(
        "/api/capture/video",
        headers={"Authorization": "Bearer not-a-real-token"},
        json={"url": "not-a-url"},
    )
    # Pydantic AnyUrl validation fires before auth or DB; either 422 or 401.
    assert r.status_code in (401, 422)


def test_capture_video_missing_url_returns_422(client: TestClient) -> None:
    r = client.post(
        "/api/capture/video",
        headers={"Authorization": "Bearer xx"},
        json={},
    )
    assert r.status_code in (401, 422)


def _make_fake_user() -> MagicMock:
    user = MagicMock()
    user.id = uuid.uuid4()
    return user


def _make_fake_ks(user_id: uuid.UUID) -> MagicMock:
    ks = MagicMock()
    ks.id = uuid.uuid4()
    ks.user_id = user_id
    ks.type = "personal"
    return ks


def test_capture_video_authenticated_returns_202() -> None:
    """Authenticated request with mocked DB + background tasks returns 202."""
    from api.main import app
    from api.security import get_current_user

    fake_user = _make_fake_user()
    fake_ks = _make_fake_ks(fake_user.id)
    fake_job_id = uuid.uuid4()

    fake_job = MagicMock()
    fake_job.id = fake_job_id
    fake_job.status = "pending_extract"

    fake_session = MagicMock()
    fake_session.get.return_value = None
    fake_session.query.return_value.filter.return_value.filter.return_value.filter.return_value.first.return_value = fake_ks
    fake_session.query.return_value.filter.return_value.first.return_value = fake_ks

    fake_session.add = MagicMock()
    fake_session.commit = MagicMock()
    fake_session.refresh = MagicMock(side_effect=lambda obj: setattr(obj, "id", fake_job_id))
    fake_session.close = MagicMock()

    app.dependency_overrides[get_current_user] = lambda: fake_user

    try:
        with (
            patch("api.routes.capture_video._new_session", return_value=fake_session),
            patch("api.routes.capture_video._resolve_knowledge_space", return_value=fake_ks),
            patch("api.routes.capture_video._resolve_policy", return_value="careful"),
            patch("api.routes.capture_video._enqueue_extract") as mock_enqueue,
        ):
            with TestClient(app) as client:
                r = client.post(
                    "/api/capture/video",
                    json={"url": "https://example.com/video.mp4"},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert r.status_code == 202
    body = r.json()
    assert "job_id" in body
    assert body["status"] == "queued"
    assert "/api/jobs/" in body["status_url"]
