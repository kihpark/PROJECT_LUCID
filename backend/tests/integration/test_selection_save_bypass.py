"""Integration: selection-save backstop — selection_text bypasses the
URL extractor chain entirely and overrides B-29 dedup on prior
extract_failed jobs.

The "Article body not found at www.newsis.com … Try the selection-save
action instead" loop fires when:
  1. The user "Save page" action runs the URL extractor (trafilatura,
     readability, newspaper3k) — all fail because newsis is JS-rendered.
  2. The user drags article body + invokes "Save selection".
  3. PRE-PR: B-29 dedup returned the FAILED job_id with duplicate=True,
     selection-save never reached the backend.
  4. POST-PR (this file): the selection retry creates a new job AND
     bypasses the extractor chain entirely.

These tests pin both the dedup override and the bypass.
"""
from __future__ import annotations

import base64
import uuid
from typing import Any
from unittest.mock import patch

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
    email = f"selbypass-{uuid.uuid4().hex[:8]}@lucid.example"
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
    }


LONG_SELECTION = (
    "대선 후보의 핵심 발언입니다. "
    "두 번째 문장도 같이 드래그됐고 본문의 의미를 충분히 전달합니다. "
    "세 번째 문장은 PO 의 검증 대상이 됩니다."
)
assert len(LONG_SELECTION) >= 50  # safety net


def _make_selection_payload(url: str, selection: str) -> dict[str, Any]:
    return {
        "source_url": url,
        "source_type": "highlighted_text",
        "captured_from": "chrome_ext",
        "raw_payload_b64": base64.b64encode(selection.encode("utf-8")).decode("ascii"),
        "client_metadata": {
            "capture_mode": "selection",
            "selection_text": selection,
            "page_title": "PO 기사 헤드라인",
        },
    }


# ---------------------------------------------------------------------------
# 1. Selection text >= 50 chars → bypass fires, web extractor not called
# ---------------------------------------------------------------------------
def test_selection_with_long_text_bypasses_url_extractor(client, auth_headers):
    """Capture a selection ≥ 50 chars on a URL the URL extractor would
    fail on (no raw HTML to extract from). The bypass fires → status
    transitions PENDING_EXTRACT → EXTRACTED with merged_text == selection.

    The web_article extractor's `extract` is mocked to raise — if the
    bypass were NOT applied, this would record extract_failed instead.
    """
    headers = auth_headers["headers"]
    url = f"https://www.newsis.com/view/{uuid.uuid4().hex}"
    payload = _make_selection_payload(url, LONG_SELECTION)

    # Make sure web extractor would fail if it were called. We patch
    # the dispatcher's `extract` to assert it isn't reached.
    with patch(
        "api.extractors.processor.dispatch_extract",
        side_effect=AssertionError(
            "dispatch_extract MUST NOT be called when selection_text >= 50",
        ),
    ):
        r = client.post("/api/capture", headers=headers, json=payload)
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    s = sec_deps._session_factory()
    try:
        job = s.get(SourceJobORM, uuid.UUID(job_id))
        assert job is not None
        assert job.status == "extracted", (
            f"selection bypass should have produced extracted, got {job.status}"
        )
        assert job.extracted_text == LONG_SELECTION
        meta = job.extracted_metadata or {}
        assert meta.get("extractor") == "selection-bypass"
        assert meta.get("capture_mode") == "selection"
        assert meta.get("title") == "PO 기사 헤드라인"
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 2. Selection-save overrides a prior extract_failed job for the same URL
# ---------------------------------------------------------------------------
def test_selection_save_overrides_failed_dedup(client, auth_headers, pg_engine):
    """First capture is a page-save that fails. Second capture is the
    selection-save retry on the SAME URL. PRE-PR the dedup guard
    returned the failed job's id. POST-PR the selection-save creates a
    new job that bypasses the extractor.
    """
    headers = auth_headers["headers"]
    url = f"https://www.newsis.com/view/{uuid.uuid4().hex}"

    # Step 1: page-save fails (no real HTML, web extractor raises).
    page_payload = {
        "source_url": url,
        "source_type": "web_article",
        "captured_from": "chrome_ext",
    }
    r1 = client.post("/api/capture", headers=headers, json=page_payload)
    assert r1.status_code == 202, r1.text
    job_id_1 = r1.json()["job_id"]
    # Force the prior job's row into extract_failed so the dedup
    # exception path engages. We don't need to actually run the
    # extractor — manipulating the row is faster + deterministic.
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    s = sec_deps._session_factory()
    try:
        job = s.get(SourceJobORM, uuid.UUID(job_id_1))
        job.status = "extract_failed"
        job.error_message = "Article body not found at www.newsis.com..."
        s.commit()
    finally:
        s.close()

    # Step 2: selection-save retry on the SAME URL — should create a
    # NEW job (duplicate is False) and run the bypass.
    sel_payload = _make_selection_payload(url, LONG_SELECTION)
    r2 = client.post("/api/capture", headers=headers, json=sel_payload)
    assert r2.status_code == 202, r2.text
    body2 = r2.json()
    assert body2.get("duplicate") is False, (
        "selection-save should NOT be deduped when prior job is extract_failed"
    )
    job_id_2 = body2["job_id"]
    assert job_id_2 != job_id_1

    # Both jobs exist now — verify DB.
    s = sec_deps._session_factory()
    try:
        job2 = s.get(SourceJobORM, uuid.UUID(job_id_2))
        assert job2 is not None
        assert job2.status == "extracted"
        assert job2.extracted_text == LONG_SELECTION
        meta = job2.extracted_metadata or {}
        assert meta.get("extractor") == "selection-bypass"
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 3. Selection < 50 chars falls through to URL extraction (no bypass)
# ---------------------------------------------------------------------------
def test_short_selection_does_not_bypass(client, auth_headers):
    """A 49-char selection is too short to be treated as authoritative;
    the normal extractor chain runs (and may fail). Bypass MUST not
    fire — the dispatcher IS called.
    """
    headers = auth_headers["headers"]
    url = f"https://example.com/short-{uuid.uuid4().hex}"
    short_selection = "x" * 49
    payload = {
        "source_url": url,
        "source_type": "highlighted_text",
        "captured_from": "chrome_ext",
        "raw_payload_b64": base64.b64encode(short_selection.encode("utf-8")).decode("ascii"),
        "client_metadata": {
            "capture_mode": "selection",
            "selection_text": short_selection,
        },
    }

    # The standard HighlightedTextExtractor takes the path-through here.
    # We do NOT patch the dispatcher — we just observe the result:
    # the extracted_metadata MUST NOT carry the selection-bypass marker.
    r = client.post("/api/capture", headers=headers, json=payload)
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    s = sec_deps._session_factory()
    try:
        job = s.get(SourceJobORM, uuid.UUID(job_id))
        assert job is not None
        meta = job.extracted_metadata or {}
        assert meta.get("extractor") != "selection-bypass", (
            "short selection MUST go through the standard extractor, "
            "not the bypass"
        )
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 4. Back-compat: no selection_text → URL extraction works as before
# ---------------------------------------------------------------------------
def test_no_selection_text_uses_url_extraction(client, auth_headers):
    """Legacy captures without `selection_text` in client_metadata must
    continue to run the URL-extractor chain (no regression for naver,
    koreadaily, etc.). We don't actually run web_article here — just
    confirm the bypass did NOT fire on a job without the key.
    """
    headers = auth_headers["headers"]
    url = f"https://example.com/legacy-{uuid.uuid4().hex}"
    payload = {
        "source_url": url,
        "source_type": "web_article",
        "captured_from": "chrome_ext",
        # No client_metadata at all.
    }
    r = client.post("/api/capture", headers=headers, json=payload)
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    s = sec_deps._session_factory()
    try:
        job = s.get(SourceJobORM, uuid.UUID(job_id))
        meta = job.extracted_metadata or {}
        assert meta.get("extractor") != "selection-bypass"
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 5. Successful prior job is NOT overridden by selection-save (safety)
# ---------------------------------------------------------------------------
def test_selection_save_does_not_override_successful_job(
    client, auth_headers, pg_engine,
):
    """If the prior job for the same URL succeeded (status=structured),
    selection-save MUST still hit the dedup guard. We never want a
    user-driven selection retry to clobber a working capture.
    """
    headers = auth_headers["headers"]
    url = f"https://www.example.com/article-{uuid.uuid4().hex}"

    r1 = client.post(
        "/api/capture",
        headers=headers,
        json={
            "source_url": url,
            "source_type": "web_article",
            "captured_from": "chrome_ext",
        },
    )
    assert r1.status_code == 202
    job_id_1 = r1.json()["job_id"]

    # Force prior job to a success-side terminal state.
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    s = sec_deps._session_factory()
    try:
        job = s.get(SourceJobORM, uuid.UUID(job_id_1))
        job.status = "structured"
        s.commit()
    finally:
        s.close()

    # Selection-save retry — MUST be deduped to the successful job.
    sel_payload = _make_selection_payload(url, LONG_SELECTION)
    r2 = client.post("/api/capture", headers=headers, json=sel_payload)
    assert r2.status_code == 202
    body2 = r2.json()
    assert body2.get("duplicate") is True, (
        "selection-save must NOT clobber a successful prior capture"
    )
    assert body2["job_id"] == job_id_1
