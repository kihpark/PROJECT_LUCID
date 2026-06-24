"""Integration: validate.decide writes step1+2+2.5 fact fields to ES.

The v0.2.0 graduation gate. We seed a SourceJob whose
extracted_metadata.structure.facts_summary carries fact_type / speaker_*
/ measurement_* fields (as the live structurer now does post
prompts-classification-recovery), call POST /decide accept-all, and
intercept the bulk_create_facts call. The FactNode that lands in the ES
bulk must carry all 10 new fields verbatim — anything dropped here would
land in lucid_facts with fact_type=null and break the recall facet.

Mocks ES like the sibling test_validate_e2e.py so the test runs without
a live cluster — the unit boundary we are pinning is
'_coerce_fact_to_factnode + FactNode -> bulk_create_facts', not the ES
round-trip.
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
        "SECRET_KEY",
        "v4b-e2e-new-fact-fields-test-secret-at-least-32-characters",
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
def auth_context(client, pg_engine):
    email = f"v02new-{uuid.uuid4().hex[:8]}@lucid.example"
    password = "longerthan8chars!"
    user_id, space_id = create_user_via_orm(pg_engine, email, password)
    login = client.post(
        "/api/auth/login", json={"email": email, "password": password},
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, uuid.UUID(user_id), uuid.UUID(space_id)


def _seed_job_with_facts(user_id, space_id, facts: list[dict]) -> uuid.UUID:
    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
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
            source_url="https://example.com/v02-new-fields",
            source_type="web_article",
            captured_from="chrome_ext",
            captured_at=datetime.now(UTC),
            raw_payload=b"",
            status="structured",
            extracted_text="Some text.",
            extracted_metadata={"structure": structure},
        )
        s.add(j)
        s.commit()
        s.refresh(j)
        return j.id


def _claim_fact() -> dict:
    return {
        "fact_uid": "fn-claim-1",
        "uid": "fn-claim-1",
        "claim": "한국은행 총재는 금리 인하 가능성을 시사했다.",
        "type": "proposition",
        "subject_uid": "obj-bok",
        "predicate": "stated",
        "object_value": "금리 인하 가능성",
        "fact_type": "claim",
        "speaker_uid": "obj-bok",
        "speaker_label": "한국은행 총재",
        "speech_act": "시사했다",
        "content_claim": "금리 인하 가능성",
        "stance": "neutral",
    }


def _measurement_fact() -> dict:
    return {
        "fact_uid": "fn-meas-1",
        "uid": "fn-meas-1",
        "claim": "ChatGPT의 MAU는 2026년 3월 기준 8억 명이다.",
        "type": "proposition",
        "subject_uid": "obj-chatgpt",
        "predicate": "has_metric",
        "object_value": "MAU",
        "fact_type": "measurement",
        "metric": "ChatGPT의 월간 활성 사용자 (MAU)",
        "measurement_value": 800000000.0,
        "measurement_unit": "명",
        "as_of": "2026-03",
    }


def _legacy_fact() -> dict:
    return {
        "fact_uid": "fn-legacy-1",
        "uid": "fn-legacy-1",
        "claim": "Legacy fact captured before step 1 prompts.",
        "type": "proposition",
        "subject_uid": "obj-legacy",
        "predicate": "is",
        "object_value": "legacy",
    }


# --------------------------------------------------------------------------
# 1. fact_type='claim' facts: speaker / speech_act / content_claim / stance
#    survive the decide -> bulk_create_facts boundary.
# --------------------------------------------------------------------------
def test_decide_writes_claim_fields_to_es(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_job_with_facts(user_id, space_id, [_claim_fact()])

    captured: list = []

    def _capture(nodes, with_embedding=False):
        captured.extend(nodes)
        return [n.fact_uid for n in nodes]

    with patch(
        "api.storage.elasticsearch.facts.bulk_create_facts",
        side_effect=_capture,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [
                    {"fact_uid": "fn-claim-1", "action": "accept"},
                ],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text
    assert captured, "bulk_create_facts must be called for accepts"
    node = captured[0]
    assert node.fact_type == "claim"
    assert node.speaker_uid == "obj-bok"
    assert node.speaker_label == "한국은행 총재"
    assert node.speech_act == "시사했다"
    assert node.content_claim == "금리 인하 가능성"
    assert node.stance == "neutral"


# --------------------------------------------------------------------------
# 2. fact_type='measurement' facts: metric / value / unit / as_of survive.
# --------------------------------------------------------------------------
def test_decide_writes_measurement_fields_to_es(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_job_with_facts(user_id, space_id, [_measurement_fact()])

    captured: list = []

    def _capture(nodes, with_embedding=False):
        captured.extend(nodes)
        return [n.fact_uid for n in nodes]

    with patch(
        "api.storage.elasticsearch.facts.bulk_create_facts",
        side_effect=_capture,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [
                    {"fact_uid": "fn-meas-1", "action": "accept"},
                ],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text
    assert captured, "bulk_create_facts must be called for accepts"
    node = captured[0]
    assert node.fact_type == "measurement"
    assert node.metric == "ChatGPT의 월간 활성 사용자 (MAU)"
    assert node.measurement_value == 800000000.0
    assert node.measurement_unit == "명"
    assert node.as_of == "2026-03"


# --------------------------------------------------------------------------
# 3. Legacy facts without the new fields still write a valid FactNode
#    with fact_type=None — back-compat for facts captured pre-step1.
# --------------------------------------------------------------------------
def test_decide_legacy_fact_defaults_fact_type_to_none(client, auth_context):
    headers, user_id, space_id = auth_context
    job_id = _seed_job_with_facts(user_id, space_id, [_legacy_fact()])

    captured: list = []

    def _capture(nodes, with_embedding=False):
        captured.extend(nodes)
        return [n.fact_uid for n in nodes]

    with patch(
        "api.storage.elasticsearch.facts.bulk_create_facts",
        side_effect=_capture,
    ):
        resp = client.post(
            f"/api/spaces/{space_id}/pending/{job_id}/decide",
            headers=headers,
            json={
                "decisions": [
                    {"fact_uid": "fn-legacy-1", "action": "accept"},
                ],
                "object_decisions": [],
            },
        )
    assert resp.status_code == 200, resp.text
    assert captured, "bulk_create_facts must be called for accepts"
    node = captured[0]
    assert node.fact_type is None
    assert node.speaker_uid is None
    assert node.metric is None
    assert node.measurement_value is None
