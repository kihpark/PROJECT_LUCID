"""Integration test — recall MUST NOT return non-manual facts.

PO open question 7 (integration proposal §10) made this regression test
a hard requirement: the dogfood pitch ("you can trust this because YOU
validated it") is only meaningful if the recall path is auditable.

Setup: seed three FactNodes into a fresh KnowledgeSpace via the real
ES client:
  1. fn-manual    validation_method='manual'   <- MUST appear
  2. fn-auto      validation_method='auto'     <- MUST NOT appear
  3. fn-other-ks  validation_method='manual'   <- wrong space, MUST NOT appear

Then hit GET /api/spaces/{sid}/recall?q=... and assert.

This file uses the existing FastAPI TestClient pattern (see
test_capture_to_extract_e2e.py).
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timezone

import pytest
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "recall-validated-only-test-secret-at-least-32-chars-long",
    )


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    from fastapi.testclient import TestClient

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
        recall as recall_route,
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
        auth_route, cap_route, job_route, sp_route, u_route,
        val_route, recall_route,
    ):
        mod._new_session = lambda sm=sm: sm()
    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_ctx(client):
    """Register a user and return (headers, user_id, space_id)."""
    email = f"recall-{uuid.uuid4().hex[:8]}@lucid.example"
    reg = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longerthan8chars!"},
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    from sqlalchemy import select

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


def _index_fact(
    fact_uid: str, claim: str, knowledge_space_id: str,
    validation_method: str, embedding: list[float],
) -> None:
    """Insert one ES doc by hand (bypassing the API layer) to set
    validation_method = 'auto' which the API layer would refuse."""
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client
    client = get_client()
    doc = {
        "fact_uid": fact_uid,
        "claim": claim,
        "claim_en": None,
        "type": "proposition",
        "subject_uid": "obj-seed-1",
        "predicate": "is",
        "object_value": "test",
        "source_uids": ["src-seed-1"],
        "validated_at": datetime.now(UTC).isoformat(),
        "validator_id": "user-seed",
        "validation_method": validation_method,
        "knowledge_space_id": knowledge_space_id,
        "negation_flag": False,
        "negation_scope": None,
        "embedding": embedding,
        "tags": [],
        "aliases": [],
        "override_warning": False,
    }
    client.index(index=LUCID_FACTS, id=fact_uid, document=doc, refresh="wait_for")


def _delete_fact(fact_uid: str) -> None:
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client
    try:
        get_client().delete(index=LUCID_FACTS, id=fact_uid, refresh="wait_for")
    except Exception:
        pass


def test_recall_returns_only_manual_facts(client, auth_ctx, monkeypatch):
    """Three seeded facts, only the manual one in the right space appears."""
    headers, _user_id, ks_id = auth_ctx
    ks = str(ks_id)
    other_ks = str(uuid.uuid4())

    # Use a fixed query embedding so all seeded facts are co-located.
    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    uids = [f"fn-recall-{uuid.uuid4().hex[:6]}-{i}" for i in range(3)]
    _index_fact(uids[0], "Manual fact in this space", ks, "manual", [0.1] * 1536)
    _index_fact(uids[1], "Auto fact in this space", ks, "auto", [0.1] * 1536)
    _index_fact(uids[2], "Manual fact in OTHER space", other_ks, "manual", [0.1] * 1536)

    try:
        resp = client.get(
            f"/api/spaces/{ks_id}/recall",
            params={"q": "fact", "limit": 50},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        returned_uids = {f["fact_uid"] for f in body["facts"]}

        assert uids[0] in returned_uids, "manual + correct space MUST appear"
        assert uids[1] not in returned_uids, (
            "auto-validated fact MUST NOT appear — zero hallucination contract"
        )
        assert uids[2] not in returned_uids, (
            "fact from a different space MUST NOT appear"
        )

        for fact in body["facts"]:
            assert fact["validation_method"] == "manual"
    finally:
        for u in uids:
            _delete_fact(u)


def test_recall_empty_space_returns_empty_signature(client, auth_ctx, monkeypatch):
    """A space with zero stored facts returns the empty signature."""
    headers, _user_id, ks_id = auth_ctx

    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    resp = client.get(
        f"/api/spaces/{ks_id}/recall",
        params={"q": "anything"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["facts"] == []
    assert body["total"] == 0
    assert body["signature"] == "검증된 사실이 없습니다"


def test_recall_korean_query_is_first_class(client, auth_ctx, monkeypatch):
    """A pure-Korean query reaches the recall pipeline + returns the
    matching manual fact. We force a constant embedding so this isn't a
    semantic-quality test; it asserts the route + ES layer accept
    Korean strings through to the signature."""
    headers, _user_id, ks_id = auth_ctx
    ks = str(ks_id)

    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    uid = f"fn-ko-{uuid.uuid4().hex[:8]}"
    _index_fact(
        uid,
        "한국은행 기준금리는 2024년 12월 기준 3.0%였다.",
        ks,
        "manual",
        [0.1] * 1536,
    )

    try:
        resp = client.get(
            f"/api/spaces/{ks_id}/recall",
            params={"q": "한국은행 기준금리"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] >= 1
        assert any(uid == f["fact_uid"] for f in body["facts"])
        assert "그래프에" in body["signature"]
        assert "As far as I know" in body["signature"]
    finally:
        _delete_fact(uid)



def test_recall_b35_expansion_pulls_facts_sharing_entity_uid(client, auth_ctx, monkeypatch):
    """B-25 stage 2: when the embedding match yields a fact whose
    subject_uid is a canonical Object uid, the response also surfaces
    every OTHER validated fact in the same KS that references the same
    entity — either on subject_uid or on object_value (entity-shaped).

    Reproduction shape (einfomax SpaceX IPO):
      seed:  fn-direct  (subject_uid=SpaceX, object_value=85.7B USD) — direct embed match
             fn-other   (subject_uid=Goldman, object_value=SpaceX)    — only entity-link
             fn-noise   (subject_uid=Apple,   object_value=literal)   — neither, must NOT appear
    Expected:
      facts returned: fn-direct (embedding) + fn-other (entity_link)
      expanded_count: 1
    """
    headers, _user_id, ks_id = auth_ctx
    ks = str(ks_id)

    SPACEX_UID = "550e8400-e29b-41d4-a716-446655440000"
    GOLDMAN_UID = "550e8400-e29b-41d4-a716-446655440001"
    APPLE_UID = "550e8400-e29b-41d4-a716-446655440002"

    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    direct_uid = f"fn-direct-{uuid.uuid4().hex[:8]}"
    other_uid = f"fn-other-{uuid.uuid4().hex[:8]}"
    noise_uid = f"fn-noise-{uuid.uuid4().hex[:8]}"

    # All three carry the same query-aligned embedding so kNN would
    # normally surface all of them — but we then constrain the embed
    # match to ONLY fn-direct by giving the others a far-off embedding.
    _index_fact_with_subject_object(
        direct_uid, "SpaceX raised 85.7 billion USD in its IPO.",
        ks, "manual", [0.1] * 1536, SPACEX_UID, "85.7 billion USD",
    )
    _index_fact_with_subject_object(
        other_uid,  "Goldman Sachs sponsored the SpaceX IPO.",
        ks, "manual", [-0.5] * 768 + [0.5] * 768, GOLDMAN_UID, SPACEX_UID,
    )
    _index_fact_with_subject_object(
        noise_uid,  "Apple announced new products.",
        ks, "manual", [-0.5] * 768 + [0.5] * 768, APPLE_UID, "iPhone 17",
    )

    try:
        resp = client.get(
            f"/api/spaces/{ks_id}/recall",
            params={"q": "SpaceX IPO funding", "limit": 5},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        returned_uids = {f["fact_uid"] for f in body["facts"]}
        assert direct_uid in returned_uids, "embed match must be present"
        assert other_uid in returned_uids, (
            "entity-link expansion must surface the SpaceX-as-object fact"
        )
        assert noise_uid not in returned_uids, (
            "unrelated facts must not leak in via the expansion"
        )

        # match_kind labelling: direct is "embedding", expanded is "entity_link"
        kinds = {f["fact_uid"]: f.get("match_kind", "embedding") for f in body["facts"]}
        assert kinds[direct_uid] == "embedding"
        assert kinds[other_uid] == "entity_link"
        assert body["expanded_count"] >= 1
    finally:
        for u in (direct_uid, other_uid, noise_uid):
            _delete_fact(u)


def _index_fact_with_subject_object(
    fact_uid: str,
    claim: str,
    knowledge_space_id: str,
    validation_method: str,
    embedding: list[float],
    subject_uid: str,
    object_value: str,
) -> None:
    """Variant of _index_fact that lets the caller set subject_uid +
    object_value to canonical entity uids (the B-35 wire format)."""
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client
    client = get_client()
    doc = {
        "fact_uid": fact_uid,
        "claim": claim,
        "claim_en": None,
        "type": "proposition",
        "subject_uid": subject_uid,
        "predicate": "p",
        "object_value": object_value,
        "source_uids": ["src-seed-1"],
        "validated_at": datetime.now(UTC).isoformat(),
        "validator_id": "user-seed",
        "validation_method": validation_method,
        "knowledge_space_id": knowledge_space_id,
        "negation_flag": False,
        "negation_scope": None,
        "embedding": embedding,
        "tags": [],
        "aliases": [],
        "override_warning": False,
    }
    client.index(index=LUCID_FACTS, id=fact_uid, document=doc, refresh="wait_for")
