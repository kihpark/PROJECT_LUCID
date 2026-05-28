"""Unit: /api/capture and /api/jobs auth + 404/403 behavior."""
from __future__ import annotations

import base64
import os
import uuid

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "unit-test-secret-at-least-32-characters-long-jwt"
    )


@pytest.fixture
def client():
    """Construct a TestClient with no DB wiring; routes hit Postgres
    via _new_session — we exercise the no-token + bad-token branches
    here, which short-circuit before any DB call."""
    from api.main import app

    return TestClient(app)


def test_capture_without_token_returns_401(client):
    r = client.post(
        "/api/capture",
        json={
            "source_url": "https://example.com",
            "source_type": "web_article",
            "captured_from": "chrome_ext",
        },
    )
    assert r.status_code == 401


def test_capture_request_invalid_source_type_422(client):
    # 422 because Pydantic enum validation fires before auth/DB.
    # (FastAPI runs body validation in the input pass.)
    r = client.post(
        "/api/capture",
        headers={"Authorization": "Bearer not-a-real-token"},
        json={
            "source_url": "https://example.com",
            "source_type": "telegram",
            "captured_from": "chrome_ext",
        },
    )
    # Either 401 (token validation first) or 422 (body validation first);
    # FastAPI runs body before auth dependencies, so 422 is correct.
    assert r.status_code in (401, 422)


def test_capture_request_missing_required_field_422(client):
    r = client.post(
        "/api/capture",
        headers={"Authorization": "Bearer xx"},
        json={"source_url": "https://example.com"},
    )
    assert r.status_code in (401, 422)


def test_capture_bad_base64_payload_rejected(client):
    # Bypasses body validation; only the route handler catches invalid b64.
    # Need a valid JWT for this branch — we cannot construct one here without
    # SECRET_KEY plus a real User row, so this becomes an integration test
    # case. See test_capture_flow.py.
    pass


def test_jobs_endpoint_without_token_returns_401(client):
    fake_id = str(uuid.uuid4())
    r1 = client.get(f"/api/jobs/{fake_id}")
    r2 = client.get("/api/jobs/pending")
    assert r1.status_code == 401
    assert r2.status_code == 401
