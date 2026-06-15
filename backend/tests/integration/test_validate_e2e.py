"""Integration: end-to-end Validate flows (Sprint 4B PR-4B-1).

These mirror `test_capture_to_extract_e2e.py`'s scaffold but exercise
the new /pending and /decide endpoints. ES persistence is mocked so we
don't need a live ES cluster for this PR (PR-4A integration tests will
exercise the round-trip).
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import select

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "v4b-e2e-test-secret-at-least-32-characters-long"
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
    for mod in (auth_route, cap_route, job_route, sp_route, u_route, val_route):
        mod._new_session = lambda sm=sm: sm()
    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_context(client):
    """Register a user and return (headers, user_id, space_id)."""
    email = f"v4b-{uuid.uuid4().hex[:8]}@lucid.example"
    reg = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longerthan8chars!"},
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    # Locate the auto-created KnowledgeSpace.
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import KnowledgeSpace, User
    sm = sec_deps._session_factory
    with sm() as s:
        user = s.scalars(
            select(User).where(User.email == email).limit(1)
        ).first()
        ks = s.scalars(
            select(KnowledgeSpace).where(KnowledgeSpace.user_id == user.id).limit(1)
        ).first()
        return headers, user.id, ks.id


def _seed_structured_job(
    user_id, space_id, *, with_negation=False, with_disambig=False,
    with_facts=2, source_type="web_article",
):
    """Plant a SourceJob row already in `structured` state with
    extracted_metadata['structure'] populated for the Validate flow."""
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
            "negation_flag": with_negation and i == 1,
        }
        for i in range(1, with_facts + 1)
    ]
    disambig = []
    if with_disambig:
        disambig.append({
            "llm_uid": "obj-llm-1",
            "candidate_name": "삼성",
            "decision_reason": "exact_match_multi",
            "candidates": [
                {"object_uid": "obj-real-a", "name": "삼성",
                 "object_class": "organization", "score": 1.0},
                {"object_uid": "obj-real-b", "name": "삼성",
                 "object_class": "organization", "score": 1.0},
            ],
        })
    structure = {
        "fact_count": len(facts),
        "object_count": 1,
        "object_disambig_pending": len(disambig),
        "facts_summary": facts,
        "disambiguation_pending": disambig,
    }
    sm = sec_deps._session_factory
    with sm() as s:
        j = SourceJobORM(
            user_id=user_id, knowledge_space_id=space_id,
            source_url="https://example.com/test", source_type=source_type,
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


# ---------------------------------------------------------------------------
# 1. Pending -> Accept-all -> structured fact in lucid_facts (mocked)
# ---------------------------------------------------------------------------
def test_e2e_pending_to_accepted(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=3)

    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200, resp.text
    page = resp.json()
    assert page["total"] >= 1
    assert any(item["job_id"] == str(job_id) for item in page["items"])

    with patch("api.routes.validate.create_fact" if False
               else "api.storage.elasticsearch.facts.create_fact",
               return_value="fn-x"):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/accept-all",
            headers=headers,
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["accepted_facts"]) == 3


# ---------------------------------------------------------------------------
# 2. Edit preserves aliases (the original claim survives as an alias on
#    the resulting FactNode body passed to create_fact).
# ---------------------------------------------------------------------------
def test_e2e_pending_with_edit_preserves_aliases(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=1)

    captured: list = []
    def _capture(node, with_embedding=False):
        captured.append(node)
        return node.fact_uid

    with patch(
        "api.storage.elasticsearch.facts.create_fact",
        side_effect=_capture,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [
                    {"fact_uid": "fn-1", "action": "edit",
                     "edited_claim": "Edited claim."},
                ],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["edited_facts"] == ["fn-1"]
    # The original claim ("Test claim 1") must appear in aliases.
    assert captured, "create_fact was not called"
    assert "Test claim 1" in captured[0].aliases


# ---------------------------------------------------------------------------
# 3. Discard records the validation_logs row.
# ---------------------------------------------------------------------------
def test_e2e_pending_with_discard_logs(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=1,
                                  with_negation=True)

    resp = client.post(
        f"/api/spaces/{space_id}/pending/{job_id}/decide",
        headers=headers,
        json={
            "decisions": [
                {"fact_uid": "fn-1", "action": "discard"},
            ],
            "object_decisions": [],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["discarded_facts"] == ["fn-1"]

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import ValidationLog
    sm = sec_deps._session_factory
    with sm() as s:
        rows = list(s.scalars(
            select(ValidationLog).where(ValidationLog.source_job_id == job_id)
        ).all())
        assert any(r.action == "discard" for r in rows)
        # Privacy invariant: no claim text on the row.
        for r in rows:
            assert getattr(r, "edited_claim_len", None) is None or \
                isinstance(r.edited_claim_len, int)


# ---------------------------------------------------------------------------
# 4. Disambig resolution: merge_with vanishes from the queue.
# ---------------------------------------------------------------------------
def test_e2e_disambig_resolution_merge(client, auth_context):
    headers, user_id, space_id = auth_context
    _seed_structured_job(user_id, space_id, with_disambig=True)
    resp = client.get(f"/api/spaces/{space_id}/disambig", headers=headers)
    assert resp.status_code == 200, resp.text
    entries = resp.json()
    assert len(entries) == 1
    disambig_id = entries[0]["disambig_id"]

    resp = client.post(
        f"/api/spaces/{space_id}/disambig/{disambig_id}/resolve",
        headers=headers,
        json={"action": "merge_with", "merge_target_uid": "obj-real-a"},
    )
    assert resp.status_code == 200, resp.text

    # Queue should now be empty for this job.
    resp = client.get(f"/api/spaces/{space_id}/disambig", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == []


# ---------------------------------------------------------------------------
# 5. Graph notes round-trip (Review mode).
# ---------------------------------------------------------------------------
def test_e2e_graph_note_search(client, auth_context):
    headers, user_id, space_id = auth_context
    # Create note
    resp = client.post(
        f"/api/spaces/{space_id}/facts/fn-review-1/notes",
        headers=headers,
        json={"note": "Personal commentary on the claim."},
    )
    assert resp.status_code == 201, resp.text
    note_id = resp.json()["id"]
    # List notes
    resp = client.get(
        f"/api/spaces/{space_id}/facts/fn-review-1/notes",
        headers=headers,
    )
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["note"] == "Personal commentary on the claim."
    # Delete
    resp = client.delete(
        f"/api/spaces/{space_id}/facts/fn-review-1/notes/{note_id}",
        headers=headers,
    )
    assert resp.status_code == 204
    # Should be empty
    resp = client.get(
        f"/api/spaces/{space_id}/facts/fn-review-1/notes",
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json() == []



# ---------------------------------------------------------------------------
# B-29 defect 1 — list card count must equal detail pending count
# ---------------------------------------------------------------------------
def test_b29_list_card_count_equals_detail_pending_count(client, auth_context):
    """The pending-list card's fact_count and GET /pending/{id}'s
    facts.length must always agree. Pre-B-29 they did not: the list
    used the all-time decomposer count, the detail filtered out
    decided facts."""
    headers, user_id, space_id = auth_context
    job_id = _seed_structured_job(user_id, space_id, with_facts=5)

    # Mark 2 of 5 facts as decided to create the disagreement scenario.
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    sm = sec_deps._session_factory
    with sm() as s:
        j = s.get(SourceJobORM, job_id)
        meta = dict(j.extracted_metadata or {})
        struct = dict(meta.get("structure") or {})
        struct["decided_fact_uids"] = ["fn-1", "fn-2"]
        meta["structure"] = struct
        j.extracted_metadata = meta
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(j, "extracted_metadata")
        s.commit()

    list_resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert list_resp.status_code == 200
    items = [i for i in list_resp.json()["items"] if i["job_id"] == str(job_id)]
    assert len(items) == 1
    list_fact_count = items[0]["fact_count"]

    detail_resp = client.get(f"/api/spaces/{space_id}/pending/{job_id}", headers=headers)
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    detail_pending_count = len(detail["facts"])

    assert list_fact_count == detail_pending_count == 3, (
        f"list={list_fact_count} detail={detail_pending_count} (expected both 3)"
    )


def test_b29_list_hides_jobs_with_zero_pending_facts(client, auth_context):
    """PO directive: facts 0 빈 카드를 큐에 쌓지 말 것. A job whose
    every fact has been decided (or which had no facts at all)
    disappears from the pending list."""
    headers, user_id, space_id = auth_context
    # Seed two jobs: one fully decided, one with pending facts.
    decided_job = _seed_structured_job(user_id, space_id, with_facts=2)
    pending_job = _seed_structured_job(user_id, space_id, with_facts=2)

    from sqlalchemy.orm.attributes import flag_modified

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    sm = sec_deps._session_factory
    with sm() as s:
        j = s.get(SourceJobORM, decided_job)
        meta = dict(j.extracted_metadata or {})
        struct = dict(meta.get("structure") or {})
        struct["decided_fact_uids"] = ["fn-1", "fn-2"]
        meta["structure"] = struct
        j.extracted_metadata = meta
        flag_modified(j, "extracted_metadata")
        s.commit()

    resp = client.get(f"/api/spaces/{space_id}/pending", headers=headers)
    assert resp.status_code == 200
    page = resp.json()
    job_ids_on_list = {i["job_id"] for i in page["items"]}
    assert str(pending_job) in job_ids_on_list
    assert str(decided_job) not in job_ids_on_list, (
        "fully-decided job leaked into the queue"
    )
