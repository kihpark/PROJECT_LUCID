"""Unit tests for POST /api/assistant/brief (M4a verified-briefing).

Covers:
  1. Happy path: 3 facts retrieved, LLM picks 2 uids -> 2 verified + inference, grounded=True
  2. Hallucination guard: LLM returns fake uid not in retrieval -> dropped
  3. Empty retrieval -> grounded=False, verified=[], inference contains "검증된 지식"
  4. LLM returns grounded=False -> verified=[], grounded=False
  5. LLM transport error -> top-5 verified, inference notes unavailability
  6. Cross-user space -> 403
  7. Unauthenticated -> 401
  8. Empty query -> 422
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.security import get_current_user


def _make_user(user_id=None):
    user = MagicMock()
    user.id = user_id or uuid4()
    return user


def _make_ks(ks_id, user_id):
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user_id
    return ks


def _session_returning(ks):
    session = MagicMock()
    session.get.return_value = ks
    return session


def _make_hit(fact_uid: str, claim: str, ks_id: str) -> dict[str, Any]:
    return {
        "_source": {
            "fact_uid": fact_uid,
            "claim": claim,
            "subject_uid": f"subj-{fact_uid}",
            "predicate": "relates_to",
            "object_value": "obj-val",
            "source_uids": [f"src-{fact_uid}"],
            "validated_at": "2026-06-01T10:00:00Z",
            "validator_id": "u-1",
            "validation_method": "manual",
            "knowledge_space_id": ks_id,
            "negation_flag": False,
            "negation_scope": None,
        },
        "_score": 0.85,
    }


def _override_auth(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _clear_overrides():
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# 1. Happy path
# ---------------------------------------------------------------------------

def test_assistant_brief_happy_path():
    """3 facts retrieved, LLM picks 2 uids -> 2 verified entries, grounded=True."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_returning(ks)

    hits = [
        _make_hit("fn-1", "fact one", str(ks_id)),
        _make_hit("fn-2", "fact two", str(ks_id)),
        _make_hit("fn-3", "fact three", str(ks_id)),
    ]
    llm_response = {
        "relevant_fact_uids": ["fn-1", "fn-2"],
        "inference": "Based on the facts, here is the answer.",
        "grounded": True,
    }

    _override_auth(user)
    try:
        with patch("api.routes.assistant._new_session", return_value=session), \
             patch("api.routes.assistant.get_embedding", return_value=[0.1] * 1536), \
             patch("api.routes.assistant._knn_facts_validated_only", return_value=hits), \
             patch("api.routes.assistant.call_claude_structured", return_value=llm_response):
            client = TestClient(app)
            resp = client.post(
                "/api/assistant/brief",
                json={"query": "test question", "space_id": str(ks_id)},
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["grounded"] is True
    assert len(body["verified"]) == 2
    returned_uids = {v["fact_uid"] for v in body["verified"]}
    # All returned fact_uids must be from the original retrieval set
    assert returned_uids <= {"fn-1", "fn-2", "fn-3"}, (
        "Returned fact_uids must be a subset of the retrieved candidates."
    )
    assert returned_uids == {"fn-1", "fn-2"}
    assert body["inference"] == "Based on the facts, here is the answer."


# ---------------------------------------------------------------------------
# 2. Hallucination guard
# ---------------------------------------------------------------------------

def test_assistant_brief_hallucination_guard():
    """LLM returns a fake uid not in retrieval set -> it is dropped silently."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_returning(ks)

    hits = [_make_hit("fn-real", "real fact", str(ks_id))]
    llm_response = {
        "relevant_fact_uids": ["fn-real", "fn-HALLUCINATED"],
        "inference": "Synthesized answer.",
        "grounded": True,
    }

    _override_auth(user)
    try:
        with patch("api.routes.assistant._new_session", return_value=session), \
             patch("api.routes.assistant.get_embedding", return_value=[0.1] * 1536), \
             patch("api.routes.assistant._knn_facts_validated_only", return_value=hits), \
             patch("api.routes.assistant.call_claude_structured", return_value=llm_response):
            client = TestClient(app)
            resp = client.post(
                "/api/assistant/brief",
                json={"query": "question", "space_id": str(ks_id)},
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["grounded"] is True
    returned_uids = {v["fact_uid"] for v in body["verified"]}
    # The hallucinated uid must not appear in the response
    assert "fn-HALLUCINATED" not in returned_uids, (
        "Hallucination guard: fake fact_uid must NEVER appear in verified output."
    )
    assert "fn-real" in returned_uids


# ---------------------------------------------------------------------------
# 3. Empty retrieval
# ---------------------------------------------------------------------------

def test_assistant_brief_empty_retrieval():
    """0 candidates from ES -> grounded=False, verified=[], inference contains '검증된 지식'."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_returning(ks)

    _override_auth(user)
    try:
        with patch("api.routes.assistant._new_session", return_value=session), \
             patch("api.routes.assistant.get_embedding", return_value=[0.1] * 1536), \
             patch("api.routes.assistant._knn_facts_validated_only", return_value=[]):
            client = TestClient(app)
            resp = client.post(
                "/api/assistant/brief",
                json={"query": "unknown topic", "space_id": str(ks_id)},
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["grounded"] is False
    assert body["verified"] == []
    assert "검증된 지식" in body["inference"]


# ---------------------------------------------------------------------------
# 4. LLM returns grounded=False
# ---------------------------------------------------------------------------

def test_assistant_brief_llm_not_grounded():
    """LLM signals grounded=False -> verified=[], grounded=False in response."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_returning(ks)

    hits = [_make_hit("fn-1", "some fact", str(ks_id))]
    llm_response = {
        "relevant_fact_uids": [],
        "inference": "I don't know the answer from these facts.",
        "grounded": False,
    }

    _override_auth(user)
    try:
        with patch("api.routes.assistant._new_session", return_value=session), \
             patch("api.routes.assistant.get_embedding", return_value=[0.1] * 1536), \
             patch("api.routes.assistant._knn_facts_validated_only", return_value=hits), \
             patch("api.routes.assistant.call_claude_structured", return_value=llm_response):
            client = TestClient(app)
            resp = client.post(
                "/api/assistant/brief",
                json={"query": "unanswerable question", "space_id": str(ks_id)},
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    assert body["grounded"] is False
    assert body["verified"] == []


# ---------------------------------------------------------------------------
# 5. LLM transport error -> degrade to top-5 verified
# ---------------------------------------------------------------------------

def test_assistant_brief_llm_transport_error():
    """When LLM call fails, degrade to top-5 retrieved facts, note unavailability."""
    ks_id = uuid4()
    user_id = uuid4()
    user = _make_user(user_id)
    ks = _make_ks(ks_id, user_id)
    session = _session_returning(ks)

    hits = [_make_hit(f"fn-{i}", f"fact {i}", str(ks_id)) for i in range(7)]

    _override_auth(user)
    try:
        with patch("api.routes.assistant._new_session", return_value=session), \
             patch("api.routes.assistant.get_embedding", return_value=[0.1] * 1536), \
             patch("api.routes.assistant._knn_facts_validated_only", return_value=hits), \
             patch("api.routes.assistant.call_claude_structured", side_effect=RuntimeError("LLM down")):
            client = TestClient(app)
            resp = client.post(
                "/api/assistant/brief",
                json={"query": "some question", "space_id": str(ks_id)},
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 200
    body = resp.json()
    # Degrade: top-5, grounded=True (showing verified facts)
    assert body["grounded"] is True
    assert len(body["verified"]) == 5
    assert "일시 불가" in body["inference"] or "unavailable" in body["inference"].lower() or "불가" in body["inference"]
    # All returned uids must be from the retrieved set
    retrieved_uids = {f"fn-{i}" for i in range(7)}
    for v in body["verified"]:
        assert v["fact_uid"] in retrieved_uids


# ---------------------------------------------------------------------------
# 6. Cross-user space -> 403
# ---------------------------------------------------------------------------

def test_assistant_brief_cross_user_403():
    """User B requesting User A's space_id must get 403."""
    ks_id = uuid4()
    owner_id = uuid4()
    requester = _make_user()  # different user_id
    ks = _make_ks(ks_id, owner_id)
    session = _session_returning(ks)

    _override_auth(requester)
    try:
        with patch("api.routes.assistant._new_session", return_value=session):
            client = TestClient(app)
            resp = client.post(
                "/api/assistant/brief",
                json={"query": "test", "space_id": str(ks_id)},
            )
    finally:
        _clear_overrides()

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 7. Unauthenticated -> 401
# ---------------------------------------------------------------------------

def test_assistant_brief_unauthenticated():
    """No auth token -> 401."""
    _clear_overrides()  # ensure no override
    client = TestClient(app)
    resp = client.post(
        "/api/assistant/brief",
        json={"query": "test", "space_id": str(uuid4())},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 8. Empty query -> 422
# ---------------------------------------------------------------------------

def test_assistant_brief_empty_query():
    """Empty string query violates min_length=1 -> 422 validation error."""
    user = _make_user()
    _override_auth(user)
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/assistant/brief",
            json={"query": "", "space_id": str(uuid4())},
        )
    finally:
        _clear_overrides()

    assert resp.status_code == 422
