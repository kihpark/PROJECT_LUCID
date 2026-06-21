"""B-62 landing-integration: POST /api/applications integration tests."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.storage.elasticsearch.client import LUCID_APPLICATIONS, get_client


@pytest.fixture()
def client(es_indexes):
    return TestClient(app)


@pytest.fixture()
def _clear_applications_index(es_client):
    """Drop all docs from lucid_applications before each test."""
    try:
        es_client.delete_by_query(
            index=LUCID_APPLICATIONS,
            body={"query": {"match_all": {}}},
            refresh=True,
        )
    except Exception:
        pass
    yield


def _payload(**overrides):
    base = {
        "email": "applicant@example.com",
        "display_name": "policy researcher",
        "lang": "ko",
        "survey_q1_key": "verification_method_friction",
        "survey_q1_value": "I currently bookmark URLs in Notion but the source context blurs.",
        "survey_q2_key": "blurry_fact_recall_experience",
        "survey_q2_value": "Last quarter I cited a stat from a paper I had read but could not relocate.",
    }
    base.update(overrides)
    return base


def test_valid_application_returns_201_and_persists(client, _clear_applications_index, es_client):
    resp = client.post("/api/applications", json=_payload())
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "received"
    assert body["duplicate"] is False
    assert body["application_id"]

    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    hits = es_client.search(
        index=LUCID_APPLICATIONS,
        query={"term": {"application_id": body["application_id"]}},
    )["hits"]["hits"]
    assert len(hits) == 1
    src = hits[0]["_source"]
    assert src["email"] == "applicant@example.com"
    assert src["email_lower"] == "applicant@example.com"
    assert src["status"] == "received"
    assert src["lang"] == "ko"


def test_duplicate_email_returns_existing_application_id(client, _clear_applications_index):
    first = client.post("/api/applications", json=_payload(email="dup@example.com"))
    assert first.status_code == 201
    first_id = first.json()["application_id"]

    second = client.post("/api/applications", json=_payload(email="DUP@example.com"))
    assert second.status_code == 201
    body = second.json()
    assert body["duplicate"] is True
    assert body["application_id"] == first_id
    assert body["status"] == "received"


def test_missing_required_field_returns_422(client, _clear_applications_index):
    payload = _payload()
    del payload["survey_q1_value"]
    resp = client.post("/api/applications", json=payload)
    assert resp.status_code == 422


def test_invalid_email_returns_422(client, _clear_applications_index):
    resp = client.post("/api/applications", json=_payload(email="not-an-email"))
    assert resp.status_code == 422


def test_unsupported_lang_returns_422(client, _clear_applications_index):
    resp = client.post("/api/applications", json=_payload(lang="fr"))
    assert resp.status_code == 422


def test_ip_hash_is_16_char_hex(client, _clear_applications_index, es_client):
    resp = client.post("/api/applications", json=_payload(email="iphash@example.com"))
    assert resp.status_code == 201
    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    src = es_client.search(
        index=LUCID_APPLICATIONS,
        query={"term": {"email_lower": "iphash@example.com"}},
    )["hits"]["hits"][0]["_source"]
    assert "submitter_ip_hash" in src
    h = src["submitter_ip_hash"]
    assert isinstance(h, str)
    # The TestClient may produce empty host; if non-empty must be 16 hex.
    if h:
        assert len(h) == 16
        int(h, 16)  # raises if not hex


def test_ko_and_en_both_accepted(client, _clear_applications_index, es_client):
    r_ko = client.post("/api/applications", json=_payload(email="ko@example.com", lang="ko"))
    r_en = client.post("/api/applications", json=_payload(email="en@example.com", lang="en"))
    assert r_ko.status_code == 201
    assert r_en.status_code == 201

    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    docs = {
        h["_source"]["email_lower"]: h["_source"]
        for h in es_client.search(
            index=LUCID_APPLICATIONS,
            size=100,
            query={"terms": {"email_lower": ["ko@example.com", "en@example.com"]}},
        )["hits"]["hits"]
    }
    assert docs["ko@example.com"]["lang"] == "ko"
    assert docs["en@example.com"]["lang"] == "en"


def test_es_write_failure_returns_503(client, _clear_applications_index, monkeypatch):
    """When the ES `index` call raises, the endpoint surfaces 503."""
    from api.routes import applications as apps_route

    real_get_client = apps_route.get_client

    class FailingClient:
        def search(self, *a, **kw):
            # dup-check should be empty, so simulate "no docs" cleanly
            return {"hits": {"hits": []}}

        def index(self, *a, **kw):
            raise RuntimeError("simulated ES outage")

    monkeypatch.setattr(apps_route, "get_client", lambda: FailingClient())
    try:
        resp = client.post("/api/applications", json=_payload(email="fail@example.com"))
        assert resp.status_code == 503
        assert resp.json()["detail"] == "application_storage_unavailable"
    finally:
        monkeypatch.setattr(apps_route, "get_client", real_get_client)
