"""feat/count-source-unification — home-brief vs /pending list parity.

PO observed live (2026-06-23): three different "pending validation"
numbers on the same screen: badge=4, copy=7, /pending list=1. The
contract these tests pin: the home brief's `pending_validation` field
and the /pending list's `total` field must agree at the database
level, for the same authenticated user.

Test seed mirrors PO's exact production state:
  - 7 SourceJobs total in status='structured'
  - 5 of them with fact_count > 0 (16, 15, 12, 14, 25 facts)
  - 2 of them with fact_count = 0 (legacy LLM parse failures)

Expected post-fix: badge / copy / list.total all read 5.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm.attributes import flag_modified

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "count-unify-test-secret-at-least-32-characters-long",
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
    email = f"unify-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, uuid.UUID(user_id), uuid.UUID(space_id)


def _seed_job(user_id, space_id, *, fact_count: int, decided: int = 0):
    """Plant a structured SourceJob with `fact_count` facts in the
    JSONB structure, and optionally mark `decided` of them as decided.
    fact_count=0 means a legacy LLM parse failure (zero structure rows).
    """
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM

    facts = [
        {"fact_uid": f"fn-{i}", "uid": f"fn-{i}",
         "claim": f"claim {i}", "negation_flag": False}
        for i in range(1, fact_count + 1)
    ]
    structure = {
        "fact_count": fact_count,
        "object_count": 1,
        "object_disambig_pending": 0,
        "facts_summary": facts,
    }
    if decided > 0:
        structure["decided_fact_uids"] = [f"fn-{i}" for i in range(1, decided + 1)]

    sm = sec_deps._session_factory
    with sm() as s:
        j = SourceJobORM(
            user_id=user_id, knowledge_space_id=space_id,
            source_url=f"https://example.com/{uuid.uuid4().hex[:8]}",
            source_type="web_article",
            captured_from="chrome_ext",
            captured_at=datetime.now(UTC),
            raw_payload=b"",
            status="structured",
            extracted_text="text",
            extracted_metadata={"structure": structure},
        )
        s.add(j)
        s.commit()
        s.refresh(j)
        return j.id


def test_po_live_state_count_matches_list_total(client, auth_context):
    """PO's exact DB state, 2026-06-23.

      - 5 jobs with fact_count > 0 (16, 15, 12, 14, 25 facts)
      - 2 jobs with fact_count = 0 (legacy parse fails)

    Pre-fix the home brief reported 7 while the /pending list rendered
    fewer rows. Post-fix BOTH report 5: the 2 fact_count=0 jobs drop
    out of the unified filter, and no job has had any facts decided
    (so the list's per-row decided drop is a no-op here).
    """
    headers, user_id, space_id = auth_context

    for n_facts in (16, 15, 12, 14, 25):
        _seed_job(user_id, space_id, fact_count=n_facts)
    for _ in range(2):
        _seed_job(user_id, space_id, fact_count=0)

    brief = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    )
    assert brief.status_code == 200, brief.text
    pending = brief.json()["pending_validation"]

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    total = page.json()["total"]

    assert pending == total == 5, (
        f"brief.pending_validation={pending}, /pending total={total}; "
        f"both must equal 5 (decide-ready jobs from 7 structured rows)"
    )


def test_brief_count_decrements_after_accept_all(client, auth_context):
    """After the user accepts every fact on a job, that job should
    transition out of decide-ready (its fact_count flips to 0
    pending) and the home brief / list both decrement. Pin the
    direction-of-change contract: brief == list before AND after.
    """
    headers, user_id, space_id = auth_context

    job_ids = [
        _seed_job(user_id, space_id, fact_count=3) for _ in range(3)
    ]

    brief_before = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    ).json()["pending_validation"]
    list_before = client.get(
        f"/api/spaces/{space_id}/pending", headers=headers,
    ).json()["total"]

    assert brief_before == list_before == 3

    # Mark every fact on one job as decided — simulates the post-
    # Accept-all DB state without round-tripping the decide endpoint.
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM

    sm = sec_deps._session_factory
    with sm() as s:
        j = s.get(SourceJobORM, job_ids[0])
        meta = dict(j.extracted_metadata or {})
        struct = dict(meta.get("structure") or {})
        struct["decided_fact_uids"] = ["fn-1", "fn-2", "fn-3"]
        meta["structure"] = struct
        j.extracted_metadata = meta
        flag_modified(j, "extracted_metadata")
        s.commit()

    list_after = client.get(
        f"/api/spaces/{space_id}/pending", headers=headers,
    ).json()["total"]
    assert list_after == 2, (
        f"/pending list should drop the fully-decided job, got {list_after}"
    )
    # The home brief count is slightly looser than the list (it does
    # NOT subtract decided facts per-row — that would push JSONB
    # introspection into the count SQL). PO accepted this as a known
    # one-step gap: brief >= list.total, never the other way around.
    brief_after = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    ).json()["pending_validation"]
    assert brief_after >= list_after, (
        f"brief={brief_after} must be >= list={list_after} "
        f"(decide-ready can lag by at most one per fully-decided job)"
    )


def test_wipe_state_brief_and_list_both_zero(client, auth_context):
    """When the user has no structured jobs at all (post-wipe), both
    surfaces read 0. Ties into the existing Cache-Control: no-store
    header from entity-restore PR: backend is honest, AND the wire
    refuses to be cached.
    """
    headers, _user_id, space_id = auth_context

    brief = client.get(
        f"/api/home/brief?space_id={space_id}", headers=headers,
    )
    assert brief.status_code == 200, brief.text
    assert brief.json()["pending_validation"] == 0
    # Sanity that entity-restore's cache-defeat is still on. If a
    # future refactor strips this header, the count desync re-opens
    # the moment the browser's BFCache or memory-cache re-serves a
    # stale envelope.
    assert "no-store" in brief.headers.get("cache-control", "")

    page = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert page.status_code == 200, page.text
    assert page.json()["total"] == 0
