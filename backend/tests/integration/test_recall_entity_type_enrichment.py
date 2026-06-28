"""Integration test - recall surfaces subject_entity_type / object_entity_type.

fix/m32b-entity-type-degree-actual-wiring (PO 2026-06-28): the recall
route _enrich_with_labels mget pass now also pulls lucid_objects.class
and surfaces it on every RecallFact as subject_entity_type /
object_entity_type. The FE StellarGraph renderer drives node color from
ENTITY_COLORS using these fields; without the enrichment every node
falls back to STELLAR_ACCENT and the PO entity-distinction gate fails.

Three cases:
  1. subject entity in lucid_objects -> RecallFact carries subject_entity_type
  2. entity-shape object_value -> RecallFact carries object_entity_type
  3. literal object_value -> object_entity_type stays None
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import sessionmaker

from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY",
        "recall-entity-type-test-secret-at-least-32-chars-long",
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


@pytest.fixture(autouse=True)
def _ensure_test_indices():
    try:
        from api.storage.elasticsearch.indexes import create_indexes
        create_indexes()
    except Exception:  # noqa: BLE001
        pass
    yield


@pytest.fixture
def auth_ctx(client, pg_engine):
    email = f"recall-etype-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, uuid.UUID(user_id), uuid.UUID(space_id)


def _index_entity(object_uid: str, knowledge_space_id: str, name: str, klass: str) -> None:
    from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
    doc = {
        "object_uid": object_uid,
        "knowledge_space_id": knowledge_space_id,
        "name": name,
        "name_en": None,
        "class": klass,
        "entity_type": klass,
        "aliases": [],
    }
    get_client().index(
        index=LUCID_OBJECTS, id=object_uid, document=doc, refresh="wait_for",
    )


def _index_fact(
    *,
    fact_uid: str,
    knowledge_space_id: str,
    subject_uid: str,
    object_value: str,
    embedding: list[float],
) -> None:
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client
    doc = {
        "fact_uid": fact_uid,
        "claim": "test entity_type enrichment fact",
        "claim_en": None,
        "type": "proposition",
        "subject_uid": subject_uid,
        "predicate": "affiliated_with",
        "object_value": object_value,
        "source_uids": ["src-recall-etype"],
        "validated_at": datetime.now(UTC).isoformat(),
        "validator_id": "user-seed",
        "validation_method": "manual",
        "knowledge_space_id": knowledge_space_id,
        "negation_flag": False,
        "negation_scope": None,
        "embedding": embedding,
        "tags": [],
        "aliases": [],
        "override_warning": False,
        "fact_type": "action",
    }
    get_client().index(
        index=LUCID_FACTS, id=fact_uid, document=doc, refresh="wait_for",
    )


def _delete_fact(fact_uid: str) -> None:
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client
    try:
        get_client().delete(
            index=LUCID_FACTS, id=fact_uid, refresh="wait_for",
        )
    except Exception:  # noqa: BLE001
        pass


def _delete_entity(object_uid: str) -> None:
    from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
    try:
        get_client().delete(
            index=LUCID_OBJECTS, id=object_uid, refresh="wait_for",
        )
    except Exception:  # noqa: BLE001
        pass


def _new_uuid4() -> str:
    return str(uuid.uuid4())


def test_recall_response_carries_subject_entity_type(client, auth_ctx, monkeypatch):
    """A fact whose subject_uid resolves in lucid_objects must surface
    subject_entity_type = lucid_objects.class on the RecallFact, and an
    entity-shape object_value must surface object_entity_type the same
    way. This is the PO-load-bearing case for M3-2b node coloring."""
    headers, _user_id, ks_id = auth_ctx
    ks = str(ks_id)

    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    subj_uid = _new_uuid4()
    obj_uid = _new_uuid4()
    fact_uid = f"fn-etype-subj-{uuid.uuid4().hex[:8]}"
    _index_entity(subj_uid, ks, name="hong gildong", klass="person")
    _index_entity(obj_uid, ks, name="bank of korea", klass="organization")
    _index_fact(
        fact_uid=fact_uid,
        knowledge_space_id=ks,
        subject_uid=subj_uid,
        object_value=obj_uid,
        embedding=[0.1] * 1536,
    )

    try:
        resp = client.get(
            f"/api/spaces/{ks_id}/recall",
            params={"q": "entity_type"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        matching = [f for f in body["facts"] if f["fact_uid"] == fact_uid]
        assert matching, (
            f"seeded fact must surface in recall; "
            f"got {[f['fact_uid'] for f in body['facts']]}"
        )
        fact = matching[0]
        assert fact["subject_entity_type"] == "person", fact
        assert fact["object_entity_type"] == "organization", fact
    finally:
        _delete_fact(fact_uid)
        _delete_entity(subj_uid)
        _delete_entity(obj_uid)


def test_recall_object_entity_type_none_for_literal(client, auth_ctx, monkeypatch):
    """When object_value is a literal (not a UUID-shape entity ref) the
    enrichment MUST leave object_entity_type as None. Mirrors the
    object_label literal path."""
    headers, _user_id, ks_id = auth_ctx
    ks = str(ks_id)

    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    subj_uid = _new_uuid4()
    fact_uid = f"fn-etype-lit-{uuid.uuid4().hex[:8]}"
    _index_entity(subj_uid, ks, name="i sunsin", klass="person")
    _index_fact(
        fact_uid=fact_uid,
        knowledge_space_id=ks,
        subject_uid=subj_uid,
        object_value="surplus",
        embedding=[0.1] * 1536,
    )

    try:
        resp = client.get(
            f"/api/spaces/{ks_id}/recall",
            params={"q": "entity_type"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        matching = [f for f in body["facts"] if f["fact_uid"] == fact_uid]
        assert matching
        fact = matching[0]
        assert fact["subject_entity_type"] == "person", fact
        assert fact["object_entity_type"] is None, fact
    finally:
        _delete_fact(fact_uid)
        _delete_entity(subj_uid)


def test_recall_entity_type_none_for_missing_lucid_object(
    client, auth_ctx, monkeypatch,
):
    """When subject_uid is a UUID-shape ref but no lucid_objects doc
    exists, the enrichment leaves subject_entity_type as None instead
    of crashing. Mirrors the label-miss path."""
    headers, _user_id, ks_id = auth_ctx
    ks = str(ks_id)

    monkeypatch.setattr(
        "api.routes.recall.get_embedding",
        lambda text: [0.1] * 1536,
    )

    subj_uid = _new_uuid4()
    fact_uid = f"fn-etype-miss-{uuid.uuid4().hex[:8]}"
    _index_fact(
        fact_uid=fact_uid,
        knowledge_space_id=ks,
        subject_uid=subj_uid,
        object_value="literal value",
        embedding=[0.1] * 1536,
    )

    try:
        resp = client.get(
            f"/api/spaces/{ks_id}/recall",
            params={"q": "entity_type"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        matching = [f for f in body["facts"] if f["fact_uid"] == fact_uid]
        assert matching
        fact = matching[0]
        assert fact["subject_entity_type"] is None, fact
        assert fact["object_entity_type"] is None, fact
    finally:
        _delete_fact(fact_uid)