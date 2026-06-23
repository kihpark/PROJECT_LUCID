"""Integration: /pending list surfaces title + hostname (pending-card-title-date).

The PO had been seeing only the URL hostname ("n.news.naver.com") as
the headline on every Pending Queue card. Root cause was that the
/pending list response only carried `source_url`, leaving the
frontend to derive a "title" by URL-parsing — and there was no good
title to derive. This test pins the fix in three branches:

  1. The extractor saved a real article title -> API returns it.
  2. The extractor failed to find a title -> API returns the hostname.
  3. There is no title AND no parseable URL -> API returns "(제목 없음)".

The structure metadata is filled in just enough for `_job_summary` to
keep the row visible (B-29 strips empty queues), so the test doubles
as a regression check on the "fact_count gate" interaction.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "title-test-secret-at-least-32-characters-long-x"
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade):
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
    from api.routes import validate as val_route
    for mod in (auth_route, cap_route, job_route, sp_route, u_route, val_route):
        mod._new_session = lambda sm=sm: sm()
    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_context(client, pg_engine):
    email = f"title-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, uuid.UUID(user_id), uuid.UUID(space_id)


def _seed_job(
    user_id,
    space_id,
    *,
    extracted_metadata: dict,
    source_url: str = "https://example.com/article",
):
    """Plant a structured SourceJob row with a controlled metadata dict."""
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM

    # Minimal structure so B-29's "drop empty queues" gate keeps the row.
    facts_summary = [
        {
            "fact_uid": "fn-1",
            "uid": "fn-1",
            "claim": "Test claim 1",
            "type": "proposition",
            "subject_uid": "obj-1",
            "predicate": "is_a",
            "object_value": "thing",
            "negation_flag": False,
        }
    ]
    md = dict(extracted_metadata)
    md.setdefault(
        "structure",
        {
            "fact_count": 1,
            "object_count": 1,
            "object_disambig_pending": 0,
            "facts_summary": facts_summary,
            "disambiguation_pending": [],
        },
    )
    sm = sec_deps._session_factory
    with sm() as s:
        j = SourceJobORM(
            user_id=user_id,
            knowledge_space_id=space_id,
            source_url=source_url,
            source_type="web_article",
            captured_from="chrome_ext",
            captured_at=datetime.now(UTC),
            raw_payload=b"",
            status="structured",
            extracted_text="Body text.",
            extracted_metadata=md,
        )
        s.add(j)
        s.commit()
        s.refresh(j)
        return j.id


def _find_item(items: list[dict], job_id: uuid.UUID) -> dict:
    for item in items:
        if item["job_id"] == str(job_id):
            return item
    raise AssertionError(f"job {job_id} missing from /pending response")


def test_pending_list_returns_extracted_metadata_title(client, auth_context):
    """The happy path: extractor saved `title` into extracted_metadata
    and the API returns it verbatim as the card title."""
    headers, user_id, space_id = auth_context
    job_id = _seed_job(
        user_id,
        space_id,
        extracted_metadata={"title": "중국 정부, 미국 기업 10곳에 수출통제"},
        source_url="https://n.news.naver.com/article/123",
    )
    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200, resp.text
    item = _find_item(resp.json()["items"], job_id)
    assert item["title"] == "중국 정부, 미국 기업 10곳에 수출통제"
    assert item["hostname"] == "n.news.naver.com"


def test_pending_list_falls_back_to_hostname_when_title_missing(client, auth_context):
    """When the extractor produced no title the card MUST show the
    hostname (not the full URL, not None) so the row is still
    identifiable. This mirrors the pre-fix legacy behavior — we don't
    regress it for old captures."""
    headers, user_id, space_id = auth_context
    job_id = _seed_job(
        user_id,
        space_id,
        extracted_metadata={},
        source_url="https://n.news.naver.com/article/456",
    )
    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200, resp.text
    item = _find_item(resp.json()["items"], job_id)
    assert item["title"] == "n.news.naver.com"
    assert item["hostname"] == "n.news.naver.com"


def test_pending_list_uses_unparseable_url_string_as_last_resort(client, auth_context):
    """When the URL has no scheme `urlparse` returns `hostname=None`;
    we fall back to the URL string itself so the card is never empty
    nor a literal "None". Title and hostname end up the same — the
    UI still has *something* to render."""
    headers, user_id, space_id = auth_context
    job_id = _seed_job(
        user_id,
        space_id,
        extracted_metadata={},
        # urlparse returns hostname=None for anything without a scheme.
        source_url="not-a-real-url",
    )
    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200, resp.text
    item = _find_item(resp.json()["items"], job_id)
    # Both title and hostname collapse to the raw URL string — better
    # than None / "(제목 없음)" since the user can still tell rows apart.
    assert item["title"] == "not-a-real-url"
    assert item["hostname"] == "not-a-real-url"


def test_resolve_title_returns_placeholder_when_everything_empty():
    """Unit-level final-fallback check: when both metadata and hostname
    are empty, `_resolve_title` returns the localized placeholder.
    Lives next to the integration tests because it pins the same
    contract; running it via pytest is cheaper than spinning up a
    TestClient just to verify the last branch."""
    from api.routes.validate import _resolve_title

    class _Stub:
        extracted_metadata = {}

    assert _resolve_title(_Stub(), "") == "(제목 없음)"

    class _StubBody:
        extracted_metadata = {"body": "First line of body.\nSecond line."}

    # Body fallback: first line, no trailing newline.
    assert _resolve_title(_StubBody(), "") == "First line of body."


def test_pending_list_prefers_metadata_title_over_og_title(client, auth_context):
    """When both `title` and `og_title` are present, `title` wins —
    that's the field the article extractor actually populated; og_title
    is a tighter fallback for pages whose <title> is the site name."""
    headers, user_id, space_id = auth_context
    job_id = _seed_job(
        user_id,
        space_id,
        extracted_metadata={
            "title": "기사 제목",
            "og_title": "Open Graph fallback",
        },
    )
    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200, resp.text
    item = _find_item(resp.json()["items"], job_id)
    assert item["title"] == "기사 제목"
