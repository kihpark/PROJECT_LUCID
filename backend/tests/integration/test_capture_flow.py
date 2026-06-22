"""Integration: alembic 0009 + capture API + jobs endpoints."""
from __future__ import annotations

import base64
import os
import uuid

import pytest

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "integration-test-secret-at-least-32-bytes-jwt"
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    """FastAPI TestClient against a live Postgres."""
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)

    from api.security import dependencies as sec_deps
    sec_deps._session_factory = sm

    from api.routes import auth as auth_route
    from api.routes import capture as cap_route
    from api.routes import jobs as job_route
    from api.routes import spaces as sp_route
    from api.routes import users as u_route
    for mod in (auth_route, cap_route, job_route, sp_route, u_route):
        mod._new_session = lambda sm=sm: sm()

    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_headers(client, pg_engine):
    """Bootstrap a user via ORM, log in, return Authorization headers + ids."""
    email = f"capture-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    return {
        "headers": {"Authorization": f"Bearer {login.json()['access_token']}"},
        "space_id": space_id,
        "user_id": user_id,
        "email": email,
    }


def test_alembic_creates_source_jobs(pg_engine, alembic_upgrade):
    from sqlalchemy import inspect
    assert "source_jobs" in set(inspect(pg_engine).get_table_names())


def test_capture_endpoint_returns_202_and_creates_job(client, auth_headers):
    r = client.post(
        "/api/capture",
        headers=auth_headers["headers"],
        json={
            "source_url": "https://example.com/article",
            "source_type": "web_article",
            "captured_from": "chrome_ext",
        },
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "pending_extract"
    assert body["status_url"].startswith("/api/jobs/")
    job_id = body["job_id"]

    # And it is queryable via the jobs endpoint
    status = client.get(body["status_url"], headers=auth_headers["headers"])
    assert status.status_code == 200
    assert status.json()["job_id"] == job_id
    assert status.json()["captured_from"] == "chrome_ext"


def test_capture_with_compressed_payload_persists(client, auth_headers):
    raw = b"<html><body>hello world</body></html>"
    r = client.post(
        "/api/capture",
        headers=auth_headers["headers"],
        json={
            "source_url": "https://example.com/with-html",
            "source_type": "web_article",
            "captured_from": "chrome_ext",
            "raw_payload_b64": base64.b64encode(raw).decode("ascii"),
        },
    )
    assert r.status_code == 202, r.text
    # Round-trip: fetch the job, ensure the raw_payload column got
    # populated (gzipped). We only check that the cell is non-empty
    # here; full decompression test lives in the unit module.
    from sqlalchemy.orm import Session

    from api.security import dependencies as sec_deps
    from api.storage.postgres.compression import decompress_payload
    from api.storage.postgres.orm import SourceJobORM
    s: Session = sec_deps._session_factory()
    try:
        job = s.get(SourceJobORM, uuid.UUID(r.json()["job_id"]))
        assert job is not None
        assert job.raw_payload is not None and len(job.raw_payload) > 0
        # Compression is real (smaller than raw is typical for HTML)
        assert decompress_payload(job.raw_payload) == raw
    finally:
        s.close()


def test_capture_invalid_base64_returns_400(client, auth_headers):
    r = client.post(
        "/api/capture",
        headers=auth_headers["headers"],
        json={
            "source_url": "https://example.com",
            "source_type": "web_article",
            "captured_from": "chrome_ext",
            "raw_payload_b64": "@@@@not-base64@@@@",
        },
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "raw_payload_b64_invalid"


def test_jobs_endpoint_ownership_403(client, auth_headers, pg_engine):
    """User A cannot fetch user B's job."""
    # A captures a job
    r = client.post(
        "/api/capture",
        headers=auth_headers["headers"],
        json={
            "source_url": "https://example.com/private",
            "source_type": "web_article",
            "captured_from": "chrome_ext",
        },
    )
    job_id = r.json()["job_id"]

    # B bootstraps via ORM + logs in
    b_email = f"otherb-{uuid.uuid4().hex[:8]}@lucid.example"
    b_pw = "longerthan8chars!"
    create_user_via_orm(pg_engine, b_email, b_pw)
    b_login = client.post(
        "/api/auth/login", json={"email": b_email, "password": b_pw},
    )
    b_headers = {"Authorization": f"Bearer {b_login.json()['access_token']}"}

    # B tries to read A's job
    r2 = client.get(f"/api/jobs/{job_id}", headers=b_headers)
    assert r2.status_code == 403


def test_pending_jobs_filtered_by_user(client, auth_headers, pg_engine):
    # Capture 2 from current user
    for url in ("https://example.com/a", "https://example.com/b"):
        client.post(
            "/api/capture",
            headers=auth_headers["headers"],
            json={
                "source_url": url,
                "source_type": "web_article",
                "captured_from": "chrome_ext",
            },
        )
    # Capture 1 from another user (ORM bootstrap + login)
    other_email = f"o-{uuid.uuid4().hex[:8]}@x.com"
    other_pw = "longerthan8chars!"
    create_user_via_orm(pg_engine, other_email, other_pw)
    other_login = client.post(
        "/api/auth/login", json={"email": other_email, "password": other_pw},
    )
    other_h = {"Authorization": f"Bearer {other_login.json()['access_token']}"}
    client.post(
        "/api/capture",
        headers=other_h,
        json={
            "source_url": "https://example.com/other",
            "source_type": "web_article",
            "captured_from": "chrome_ext",
        },
    )

    pending = client.get("/api/jobs/pending", headers=auth_headers["headers"]).json()
    urls = {p["source_url"] for p in pending}
    assert {"https://example.com/a", "https://example.com/b"}.issubset(urls)
    assert "https://example.com/other" not in urls



# ---------------------------------------------------------------------------
# B-29 defect 3 — duplicate URL must NOT create a second job (policy i)
# ---------------------------------------------------------------------------
def test_b29_capture_duplicate_returns_existing_job(client, auth_headers):
    """Second POST of the same (user, ks, source_url) must return the
    EXISTING job_id with duplicate=True. The DB row count for that URL
    stays at 1.

    NOTE: integration tests share a Postgres instance with dogfood
    state. Use a per-run unique URL so leftover rows from other tests
    (or live PO captures) don't skew the count assertion.
    """
    headers = auth_headers["headers"]
    unique_url = f"https://b29-dedup-test.example.com/{uuid.uuid4().hex}"
    payload = {
        "source_url": unique_url,
        "source_type": "web_article",
        "captured_from": "chrome_ext",
    }
    r1 = client.post("/api/capture", headers=headers, json=payload)
    assert r1.status_code == 202, r1.text
    body1 = r1.json()
    assert body1.get("duplicate") is False
    job_id_1 = body1["job_id"]

    r2 = client.post("/api/capture", headers=headers, json=payload)
    assert r2.status_code == 202, r2.text
    body2 = r2.json()
    assert body2.get("duplicate") is True
    assert body2["job_id"] == job_id_1, (
        f"second capture returned a new job {body2['job_id']!r} "
        f"instead of the existing {job_id_1!r}"
    )

    # DB-level invariant: only one row for that URL exists.
    from sqlalchemy import func, select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    s = sec_deps._session_factory()
    try:
        count = s.scalar(
            select(func.count()).select_from(SourceJobORM).where(
                SourceJobORM.source_url == unique_url
            )
        )
        assert count == 1, f"expected 1 row, found {count}"
    finally:
        s.close()


def test_b29_capture_dedup_scoped_to_user(client, pg_engine):
    """Two different users may each save the same URL; the dedup
    guard is per-(user, ks, url), not global."""
    # User A — ORM bootstrap + login
    email_a = f"dedup-a-{uuid.uuid4().hex[:8]}@lucid.example"
    pw = "longerthan8chars!"
    create_user_via_orm(pg_engine, email_a, pw)
    login_a = client.post(
        "/api/auth/login", json={"email": email_a, "password": pw},
    )
    assert login_a.status_code == 200, login_a.text
    headers_a = {"Authorization": f"Bearer {login_a.json()['access_token']}"}

    # User B — ORM bootstrap + login
    email_b = f"dedup-b-{uuid.uuid4().hex[:8]}@lucid.example"
    create_user_via_orm(pg_engine, email_b, pw)
    login_b = client.post(
        "/api/auth/login", json={"email": email_b, "password": pw},
    )
    assert login_b.status_code == 200, login_b.text
    headers_b = {"Authorization": f"Bearer {login_b.json()['access_token']}"}

    payload = {
        "source_url": "https://example.com/scoped-dedup",
        "source_type": "web_article",
        "captured_from": "chrome_ext",
    }
    r_a = client.post("/api/capture", headers=headers_a, json=payload)
    r_b = client.post("/api/capture", headers=headers_b, json=payload)
    assert r_a.status_code == 202 and r_b.status_code == 202
    assert r_a.json()["job_id"] != r_b.json()["job_id"]
    assert r_a.json()["duplicate"] is False
    assert r_b.json()["duplicate"] is False
