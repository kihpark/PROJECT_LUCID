"""fix/r1-recall-redesign — AI 브리핑 (개관) integration tests.

The /recall/briefing endpoint is the on-demand "AI 브리핑 보기" button
the FE renders inside RecallFactTypeSummary. PO directive (2026-06-24):

  - Distinct from ORACLE (/api/assistant/brief — question answering).
    Briefing summarises the CURRENT recall set in 1-3 Korean sentences.
  - Grounded only on verified facts the recall pipeline returned
    (P1·P2: zero-hallucination contract).
  - Cost guard: on-demand button + in-memory cache (30 min TTL keyed
    on space+query+entities+fact_uids).

This module exercises the route logic by mocking the inner `recall()`
call so we don't need a live ES, then asserts:
  1. The endpoint returns 200 with a grounded briefing when verified
     facts are present and the LLM cites in-set fact_uids.
  2. The cache returns cached=True on a second identical call (no
     second LLM invocation).
  3. The zero-fact short-circuit: when recall returned no facts the
     endpoint returns an empty envelope WITHOUT calling the LLM.
  4. Grounding filter: a cited_fact_uid not in the candidate set is
     dropped so a hallucinated reference cannot escape.
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from sqlalchemy.orm import sessionmaker

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "recall-briefing-test-secret-at-least-32-chars-long",
    )


@pytest.fixture(autouse=True)
def _clear_briefing_cache():
    """The in-memory cache lives at module scope so it persists across
    tests — clear it explicitly each test so we observe cached=True
    only when THIS test caused the put."""
    from api.routes.recall import _briefing_cache
    _briefing_cache.clear()
    yield
    _briefing_cache.clear()


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    """Same pattern as test_recall_validated_only.py — pin _new_session
    on the relevant route modules to point at the test pg, then return
    a TestClient over the real app."""
    from fastapi.testclient import TestClient

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    from api.security import dependencies as sec_deps
    sec_deps._session_factory = sm
    from api.routes import auth as auth_route
    from api.routes import recall as recall_route
    from api.routes import spaces as sp_route
    from api.routes import users as u_route

    for mod in (auth_route, sp_route, u_route, recall_route):
        mod._new_session = lambda sm=sm: sm()

    from api.main import app
    return TestClient(app)


def _seed_user_space(pg_engine) -> tuple[str, str, str, str]:
    """Create a user + KS. Returns (user_id, space_id, email, password)."""
    email = f"brief-r1-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    return user_id, space_id, email, password


def _fake_fact(fact_uid: str, claim: str) -> object:
    """Mimic just enough of RecallFact for the briefing prompt."""
    from datetime import datetime, timezone

    from api.models.recall import RecallFact
    return RecallFact(
        fact_uid=fact_uid,
        claim=claim,
        subject_uid="subj-1",
        predicate="발표했다",
        object_value="정책",
        validated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        validator_id="u-1",
        validation_method="manual",
        knowledge_space_id="ks-1",
        score=0.9,
        source_uids=[],
        match_kind="embedding",
        subject_label="검증대상",
        object_label="정책",
        predicate_label="발표했다",
    )


def _fake_recall_response(facts: list) -> object:
    from api.models.recall import RecallResponse
    return RecallResponse(
        signature=(
            "검증된 사실이 없습니다" if not facts
            else f"As far as I know — 그래프에 {len(facts)}개 검증 사실이 있습니다"
        ),
        facts=facts,
        total=len(facts),
    )


def _auth_headers(client, email: str, pw: str) -> dict:
    """Bearer-token auth matching the pattern other recall integration
    tests use (test_recall_filters_new_field.py)."""
    r = client.post(
        "/api/auth/login",
        json={"email": email, "password": pw},
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_briefing_returns_grounded_text_when_recall_has_facts(
    client, pg_engine,
):
    """The happy path. recall() returns 2 verified facts; the (mocked)
    LLM cites both uids; the response carries the briefing text + the
    cited uid list and grounded=True."""
    user_id, space_id, email, password = _seed_user_space(pg_engine)
    headers = _auth_headers(client, email, password)

    fact_a = _fake_fact("fact-A", "엔티티는 정책 X를 발표했다.")
    fact_b = _fake_fact("fact-B", "엔티티는 정책 Y를 발표했다.")
    recall_resp = _fake_recall_response([fact_a, fact_b])

    llm_payload = {
        "briefing": "엔티티는 정책 X와 정책 Y를 발표했다.",
        "cited_fact_uids": ["fact-A", "fact-B"],
        "grounded": True,
    }

    with patch(
        "api.routes.recall.recall", return_value=recall_resp,
    ), patch(
        "api.structure.claude_client.call_claude_structured",
        return_value=llm_payload,
    ) as mock_llm:
        r = client.get(
            f"/api/spaces/{space_id}/recall/briefing?q=test",
            headers=headers,
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["grounded"] is True
    assert body["cached"] is False
    assert body["fact_count"] == 2
    assert body["briefing"] == "엔티티는 정책 X와 정책 Y를 발표했다."
    assert set(body["fact_uids"]) == {"fact-A", "fact-B"}
    assert mock_llm.call_count == 1


def test_briefing_cache_hits_on_repeat_call(client, pg_engine):
    """★ Cost guard. The second identical call must return cached=True
    AND must NOT invoke the LLM. This is the PO's hard requirement —
    "비용 가드: 캐싱" — encoded as a test."""
    user_id, space_id, email, password = _seed_user_space(pg_engine)
    headers = _auth_headers(client, email, password)

    fact_a = _fake_fact("fact-A", "엔티티 활동.")
    recall_resp = _fake_recall_response([fact_a])

    llm_payload = {
        "briefing": "엔티티는 활동을 했다.",
        "cited_fact_uids": ["fact-A"],
        "grounded": True,
    }

    with patch(
        "api.routes.recall.recall", return_value=recall_resp,
    ), patch(
        "api.structure.claude_client.call_claude_structured",
        return_value=llm_payload,
    ) as mock_llm:
        r1 = client.get(
            f"/api/spaces/{space_id}/recall/briefing?q=cache",
            headers=headers,
        )
        r2 = client.get(
            f"/api/spaces/{space_id}/recall/briefing?q=cache",
            headers=headers,
        )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["cached"] is False
    assert r2.json()["cached"] is True
    # The cached path returns the same text without a second LLM hit.
    assert r2.json()["briefing"] == r1.json()["briefing"]
    assert mock_llm.call_count == 1


def test_briefing_zero_facts_does_not_call_llm(client, pg_engine):
    """The PO directive: silence when there's nothing to summarise.
    A 0-fact recall must short-circuit BEFORE the LLM is called (cost
    guard — no spend on an empty briefing)."""
    user_id, space_id, email, password = _seed_user_space(pg_engine)
    headers = _auth_headers(client, email, password)

    recall_resp = _fake_recall_response([])

    with patch(
        "api.routes.recall.recall", return_value=recall_resp,
    ), patch(
        "api.structure.claude_client.call_claude_structured",
    ) as mock_llm:
        r = client.get(
            f"/api/spaces/{space_id}/recall/briefing?q=empty",
            headers=headers,
        )

    assert r.status_code == 200
    body = r.json()
    assert body["grounded"] is False
    assert body["briefing"] == ""
    assert body["fact_uids"] == []
    assert body["fact_count"] == 0
    # Hard contract: the LLM was NEVER touched.
    assert mock_llm.call_count == 0


def test_briefing_filters_out_hallucinated_fact_uids(client, pg_engine):
    """Grounding P1·P2: if the LLM returns a cited_fact_uid that's not
    in the candidate set, the route drops it. If ALL cited uids are
    bogus, grounded flips to False and the briefing text is wiped so
    no ungrounded narrative reaches the UI."""
    user_id, space_id, email, password = _seed_user_space(pg_engine)
    headers = _auth_headers(client, email, password)

    fact_real = _fake_fact("fact-REAL", "검증된 사실.")
    recall_resp = _fake_recall_response([fact_real])

    # The LLM hallucinates a fact_uid that doesn't exist in the recall
    # set. The route MUST filter it out.
    llm_payload_bogus = {
        "briefing": "엔티티는 사실 X를 발표했다.",
        "cited_fact_uids": ["fact-HALLUCINATED"],
        "grounded": True,
    }

    with patch(
        "api.routes.recall.recall", return_value=recall_resp,
    ), patch(
        "api.structure.claude_client.call_claude_structured",
        return_value=llm_payload_bogus,
    ):
        r = client.get(
            f"/api/spaces/{space_id}/recall/briefing?q=hallu",
            headers=headers,
        )

    assert r.status_code == 200
    body = r.json()
    # No surviving uids → grounded=False, text wiped.
    assert body["grounded"] is False
    assert body["briefing"] == ""
    assert body["fact_uids"] == []
    # Recall still returned 1 fact, so fact_count reflects that.
    assert body["fact_count"] == 1
