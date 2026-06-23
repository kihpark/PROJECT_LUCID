"""Integration: decide-status-transition.

PO live evidence (2026-06-22): all 10 source_jobs were stuck at
status='structured' even after Submit, so the home "검증 대기" count
never dropped. Root cause: the /decide handler wrote facts and
recorded validation_logs but never flipped source_jobs.status. This
suite locks in the fix:

  1. /decide on a structured job → status flips to 'validated'
  2. /accept-all on a structured job → status flips to 'validated'
  3. /discard on a structured job → status flips to 'validated'
  4. Validated jobs are NOT counted in home._pending_validation_count
  5. Idempotent: re-Submit on an already-validated job stays 'validated'

Tests are self-contained — they reuse the same `client` / `auth_context`
/ `_seed_structured_job` helpers as `test_validate_e2e.py`, copied in
locally so this file is independently grep-able.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "decide-status-test-secret-at-least-32-characters",
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
    from api.routes import home as home_route
    from api.routes import jobs as job_route
    from api.routes import spaces as sp_route
    from api.routes import users as u_route
    from api.routes import validate as val_route
    for mod in (
        auth_route, cap_route, home_route, job_route,
        sp_route, u_route, val_route,
    ):
        mod._new_session = lambda sm=sm: sm()
    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_context(client, pg_engine):
    email = f"decstat-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, uuid.UUID(user_id), uuid.UUID(space_id)


def _seed_structured_job(user_id, space_id, *, with_facts=2):
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    facts = [
        {
            "fact_uid": f"fn-{i}",
            "uid": f"fn-{i}",
            "claim": f"Test claim {i}",
            "type": "proposition",
            "subject_uid": "obj-1",
            "predicate": "is_a",
            "object_value": "thing",
            "negation_flag": False,
        }
        for i in range(1, with_facts + 1)
    ]
    structure = {
        "fact_count": len(facts),
        "object_count": 1,
        "object_disambig_pending": 0,
        "facts_summary": facts,
        "disambiguation_pending": [],
    }
    sm = sec_deps._session_factory
    with sm() as s:
        j = SourceJobORM(
            user_id=user_id, knowledge_space_id=space_id,
            source_url="https://example.com/decstat",
            source_type="web_article",
            captured_from="chrome_ext",
            captured_at=datetime.now(UTC),
            raw_payload=b"",
            status="structured",
            extracted_text="Some extracted text.",
            extracted_metadata={"structure": structure},
        )
        s.add(j)
        s.commit()
        s.refresh(j)
        return j.id


def _read_status(user_id, job_id):
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    sm = sec_deps._session_factory
    with sm() as s:
        j = s.get(SourceJobORM, job_id)
        assert j is not None
        assert j.user_id == user_id
        return j.status


# ---------------------------------------------------------------------------
# 1. /decide flips status to 'validated' on Submit.
# ---------------------------------------------------------------------------
def test_decide_flips_status_to_validated(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=2)

    assert _read_status(user_id, job_id) == "structured"

    with patch(
        "api.storage.elasticsearch.facts.bulk_create_facts",
        return_value=None,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [
                    {"fact_uid": "fn-1", "action": "accept"},
                    {"fact_uid": "fn-2", "action": "accept"},
                ],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text

    assert _read_status(user_id, job_id) == "validated"


# ---------------------------------------------------------------------------
# 2. /accept-all also flips status to 'validated'.
# ---------------------------------------------------------------------------
def test_accept_all_flips_status_to_validated(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=3)

    with patch(
        "api.storage.elasticsearch.facts.create_fact",
        return_value="fn-x",
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/accept-all",
            headers=headers,
        )
    assert resp.status_code == 200, resp.text

    assert _read_status(user_id, job_id) == "validated"


# ---------------------------------------------------------------------------
# 3. /discard (whole job) also flips status to 'validated'.
# ---------------------------------------------------------------------------
def test_discard_job_flips_status_to_validated(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=2)

    resp = client.post(
        f"/api/spaces/{space_id}/pending/{job_id}/discard",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    assert _read_status(user_id, job_id) == "validated"


# ---------------------------------------------------------------------------
# 4. Validated jobs are NOT counted by home._pending_validation_count.
# ---------------------------------------------------------------------------
def test_validated_job_not_in_pending_count(client, auth_context):
    headers, user_id, space_id = auth_context

    # Seed 3 structured + 1 already-validated job. The validated one
    # must NOT show up in the count.
    j1 = _seed_structured_job(user_id, space_id, with_facts=1)
    j2 = _seed_structured_job(user_id, space_id, with_facts=1)
    j3 = _seed_structured_job(user_id, space_id, with_facts=1)

    # Manually mark j3 validated to mimic a completed Submit.
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    sm = sec_deps._session_factory
    with sm() as s:
        row = s.get(SourceJobORM, j3)
        row.status = "validated"
        s.add(row)
        s.commit()

    # Direct call to the count function avoids ES side-effects from
    # the full /home brief (which queries lucid_facts).
    from api.routes.home import _pending_validation_count
    with sm() as s:
        n = _pending_validation_count(s, user_id, space_id)
    assert n == 2, (
        f"expected 2 pending (j1, j2); got {n}. j3 was validated and "
        f"must not be counted."
    )

    # And j3 must NOT show up in the pending queue.
    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200
    items = resp.json()["items"]
    ids = {item["job_id"] for item in items}
    assert str(j1) in ids
    assert str(j2) in ids
    assert str(j3) not in ids


# ---------------------------------------------------------------------------
# 5. Re-Submit on a validated job is a no-op and does not error.
#    (The frontend doesn't currently allow this — the success panel
#     hides the Submit button — but the backend should be tolerant.)
# ---------------------------------------------------------------------------
def test_decide_on_already_validated_job_is_idempotent(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=1)

    # First submit transitions structured → validated.
    with patch(
        "api.storage.elasticsearch.facts.bulk_create_facts",
        return_value=None,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [{"fact_uid": "fn-1", "action": "accept"}],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text
    assert _read_status(user_id, job_id) == "validated"

    # A second submit on the same (now-validated) job MUST NOT error
    # and MUST leave the status at 'validated'.
    with patch(
        "api.storage.elasticsearch.facts.bulk_create_facts",
        return_value=None,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [{"fact_uid": "fn-1", "action": "discard"}],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text
    assert _read_status(user_id, job_id) == "validated"
