"""feat/count-source-unification — /pending list SQL filter semantics.

These tests probe the SQLAlchemy + JSONB cast behaviour of
`_decide_ready_jobs` against a real Postgres. The unit suite mocks
the chain to pin the call shape; this suite confirms that the
generated SQL actually:

  - excludes `fact_count = 0` rows
  - excludes rows missing `extracted_metadata.structure.fact_count`
  - excludes rows where `structure` is null (extract failed before
    LLM ran)
  - excludes rows belonging to a different KS

The /pending list and the home brief count must both reflect these
exclusions consistently.
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
        "SECRET_KEY", "list-filter-test-secret-at-least-32-characters-long",
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    from api.security import dependencies as sec_deps
    sec_deps._session_factory = sm
    from api.routes import (
        auth as auth_route,
    )
    from api.routes import (
        capture as cap_route,
    )
    from api.routes import (
        home as home_route,
    )
    from api.routes import (
        jobs as job_route,
    )
    from api.routes import (
        spaces as sp_route,
    )
    from api.routes import (
        users as u_route,
    )
    from api.routes import (
        validate as val_route,
    )
    for mod in (
        auth_route, cap_route, home_route, job_route,
        sp_route, u_route, val_route,
    ):
        mod._new_session = lambda sm=sm: sm()
    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_context(client, pg_engine):
    email = f"filter-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, uuid.UUID(user_id), uuid.UUID(space_id)


def _seed_raw(user_id, space_id, *, status: str, metadata: dict):
    """Plant a SourceJob with an arbitrary status + extracted_metadata
    so we can exercise the SQL filter at the boundary cases."""
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM

    sm = sec_deps._session_factory
    with sm() as s:
        j = SourceJobORM(
            user_id=user_id, knowledge_space_id=space_id,
            source_url=f"https://example.com/{uuid.uuid4().hex[:8]}",
            source_type="web_article",
            captured_from="chrome_ext",
            captured_at=datetime.now(UTC),
            raw_payload=b"",
            status=status,
            extracted_text="text",
            extracted_metadata=metadata,
        )
        s.add(j)
        s.commit()
        s.refresh(j)
        return j.id


def test_pending_list_excludes_fact_count_zero(client, auth_context):
    """A structured job with fact_count=0 (legacy LLM parse failure)
    does NOT appear in /pending, and is not counted by the home brief.
    PO's exact pain point: 2 such jobs were inflating the badge."""
    headers, user_id, space_id = auth_context

    _seed_raw(
        user_id, space_id, status="structured",
        metadata={"structure": {
            "fact_count": 0, "object_count": 0,
            "object_disambig_pending": 0, "facts_summary": [],
        }},
    )
    keep_id = _seed_raw(
        user_id, space_id, status="structured",
        metadata={"structure": {
            "fact_count": 2, "object_count": 1,
            "object_disambig_pending": 0,
            "facts_summary": [
                {"fact_uid": "fn-1", "uid": "fn-1", "negation_flag": False},
                {"fact_uid": "fn-2", "uid": "fn-2", "negation_flag": False},
            ],
        }},
    )

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    body = page.json()
    job_ids = {i["job_id"] for i in body["items"]}
    assert str(keep_id) in job_ids
    assert body["total"] == 1, (
        f"expected only the fact_count>0 job to be listed, got {body['total']}"
    )

    brief = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    )
    assert brief.json()["pending_validation"] == 1


def test_pending_list_excludes_jobs_without_structure_key(client, auth_context):
    """Defensive: a job whose extracted_metadata is missing the
    `structure` sub-document (extract crashed mid-write) must not
    leak into pending."""
    headers, user_id, space_id = auth_context

    _seed_raw(
        user_id, space_id, status="structured",
        metadata={},  # no `structure` key at all
    )
    _seed_raw(
        user_id, space_id, status="structured",
        metadata={"structure": {}},  # empty structure (no fact_count)
    )

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    assert page.json()["total"] == 0

    brief = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    )
    assert brief.json()["pending_validation"] == 0


def test_pending_list_excludes_non_structured_status(client, auth_context):
    """Status filter still binds: extracting / extracted /
    structure_failed never appear regardless of fact_count."""
    headers, user_id, space_id = auth_context

    for st in ("pending_extract", "extracting", "extracted",
               "structuring", "extract_failed", "structure_failed"):
        _seed_raw(
            user_id, space_id, status=st,
            metadata={"structure": {
                "fact_count": 5,
                "facts_summary": [
                    {"fact_uid": f"fn-{i}", "uid": f"fn-{i}",
                     "negation_flag": False}
                    for i in range(1, 6)
                ],
            }},
        )

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    assert page.json()["total"] == 0

    brief = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    )
    assert brief.json()["pending_validation"] == 0


def test_pending_list_isolates_by_knowledge_space(client, auth_context, pg_engine):
    """A job in a DIFFERENT KS owned by the SAME user must not
    contaminate the count for the active KS. (Cross-user isolation
    is exercised in test_b61_isolation.py.)
    """
    headers, user_id, space_id = auth_context

    _seed_raw(
        user_id, space_id, status="structured",
        metadata={"structure": {
            "fact_count": 3, "facts_summary": [
                {"fact_uid": f"fn-{i}", "uid": f"fn-{i}",
                 "negation_flag": False}
                for i in range(1, 4)
            ],
        }},
    )

    # Second KS for the same user — its job must not be counted.
    from sqlalchemy.orm import sessionmaker

    from api.storage.postgres.orm import KnowledgeSpace

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    with sm() as s:
        other = KnowledgeSpace(
            user_id=user_id, type="personal", name="Other",
        )
        s.add(other)
        s.commit()
        s.refresh(other)
        other_id = other.id

    _seed_raw(
        user_id, other_id, status="structured",
        metadata={"structure": {
            "fact_count": 99, "facts_summary": [
                {"fact_uid": f"fn-{i}", "uid": f"fn-{i}",
                 "negation_flag": False}
                for i in range(1, 100)
            ],
        }},
    )

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    assert page.json()["total"] == 1, (
        "list leaked another KS's job into the active KS's pending queue"
    )

    brief = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    )
    assert brief.json()["pending_validation"] == 1


def test_pending_list_items_each_have_pending_fact_count_positive(client, auth_context):
    """Every item returned from /pending exposes `fact_count` >= 1
    (it's the PENDING fact count per B-29). Establishes the list
    contract that callers can rely on: render a card → there IS
    something to decide on it.
    """
    headers, user_id, space_id = auth_context

    for n in (2, 5, 3):
        _seed_raw(
            user_id, space_id, status="structured",
            metadata={"structure": {
                "fact_count": n, "facts_summary": [
                    {"fact_uid": f"fn-{i}", "uid": f"fn-{i}",
                     "negation_flag": False}
                    for i in range(1, n + 1)
                ],
            }},
        )

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    items = page.json()["items"]
    assert len(items) == 3
    for it in items:
        assert it["fact_count"] >= 1, (
            f"list returned an item with fact_count={it['fact_count']} "
            f"— defeats the whole point of the filter"
        )
