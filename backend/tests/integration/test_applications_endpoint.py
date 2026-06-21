"""POST /api/applications integration tests.

feat/landing-fix-spec: 4-field shape (email + profession + q1 + q2 + lang)
with server-set source / status / created_at and email_lower-based
upsert (same email -> same application_id, last-write-wins).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.storage.elasticsearch.client import LUCID_APPLICATIONS


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
        "profession": "policy researcher / AI governance",
        "q1": "I currently bookmark URLs in Notion but the source context blurs.",
        "q2": "Last quarter I cited a stat from a paper I had read but could not relocate.",
        "lang": "ko",
    }
    base.update(overrides)
    return base


def test_valid_application_returns_201_and_persists(
    client, _clear_applications_index, es_client
):
    resp = client.post("/api/applications", json=_payload())
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "pending"
    assert body["application_id"]
    assert "duplicate" not in body

    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    hits = es_client.search(
        index=LUCID_APPLICATIONS,
        query={"term": {"application_id": body["application_id"]}},
    )["hits"]["hits"]
    assert len(hits) == 1
    src = hits[0]["_source"]
    assert src["email"] == "applicant@example.com"
    assert src["email_lower"] == "applicant@example.com"
    assert src["profession"] == "policy researcher / AI governance"
    assert src["q1"]
    assert src["q2"]
    assert src["lang"] == "ko"


def test_server_side_meta_is_written(
    client, _clear_applications_index, es_client
):
    """source / status / created_at are added by the server, not the client."""
    resp = client.post("/api/applications", json=_payload(email="meta@example.com"))
    assert resp.status_code == 201
    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    src = es_client.search(
        index=LUCID_APPLICATIONS,
        query={"term": {"email_lower": "meta@example.com"}},
    )["hits"]["hits"][0]["_source"]
    assert src["source"] == "landing-v82"
    assert src["status"] == "pending"
    assert src["created_at"]
    assert "display_name" not in src
    assert "survey_q1_key" not in src
    assert "survey_q1_value" not in src
    assert "survey_q2_key" not in src
    assert "survey_q2_value" not in src
    assert "submitted_at" not in src


def test_upsert_reuses_application_id_and_overwrites_fields(
    client, _clear_applications_index, es_client
):
    """Same email -> same application_id; second submission overwrites."""
    first = client.post(
        "/api/applications",
        json=_payload(
            email="upsert@example.com",
            profession="initial profession",
            q1="initial q1 text",
            q2="initial q2 text",
        ),
    )
    assert first.status_code == 201
    first_id = first.json()["application_id"]

    second = client.post(
        "/api/applications",
        json=_payload(
            email="UPSERT@example.com",
            profession="updated profession",
            q1="updated q1 text",
            q2="updated q2 text",
            lang="en",
        ),
    )
    assert second.status_code == 201
    body = second.json()
    assert body["application_id"] == first_id
    assert body["status"] == "pending"

    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    hits = es_client.search(
        index=LUCID_APPLICATIONS,
        query={"term": {"email_lower": "upsert@example.com"}},
    )["hits"]["hits"]
    assert len(hits) == 1
    src = hits[0]["_source"]
    assert src["profession"] == "updated profession"
    assert src["q1"] == "updated q1 text"
    assert src["q2"] == "updated q2 text"
    assert src["lang"] == "en"


def test_missing_required_field_returns_422(
    client, _clear_applications_index
):
    payload = _payload()
    del payload["q1"]
    resp = client.post("/api/applications", json=payload)
    assert resp.status_code == 422


def test_missing_profession_returns_422(
    client, _clear_applications_index
):
    payload = _payload()
    del payload["profession"]
    resp = client.post("/api/applications", json=payload)
    assert resp.status_code == 422


def test_invalid_email_returns_422(client, _clear_applications_index):
    resp = client.post("/api/applications", json=_payload(email="not-an-email"))
    assert resp.status_code == 422


def test_unsupported_lang_returns_422(client, _clear_applications_index):
    resp = client.post("/api/applications", json=_payload(lang="fr"))
    assert resp.status_code == 422


def test_ip_hash_is_16_char_hex(
    client, _clear_applications_index, es_client
):
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
    if h:
        assert len(h) == 16
        int(h, 16)


def test_ko_and_en_both_accepted(
    client, _clear_applications_index, es_client
):
    r_ko = client.post(
        "/api/applications", json=_payload(email="ko@example.com", lang="ko")
    )
    r_en = client.post(
        "/api/applications", json=_payload(email="en@example.com", lang="en")
    )
    assert r_ko.status_code == 201
    assert r_en.status_code == 201

    es_client.indices.refresh(index=LUCID_APPLICATIONS)
    docs = {
        h["_source"]["email_lower"]: h["_source"]
        for h in es_client.search(
            index=LUCID_APPLICATIONS,
            size=100,
            query={
                "terms": {"email_lower": ["ko@example.com", "en@example.com"]}
            },
        )["hits"]["hits"]
    }
    assert docs["ko@example.com"]["lang"] == "ko"
    assert docs["en@example.com"]["lang"] == "en"


def test_es_write_failure_returns_503(
    client, _clear_applications_index, monkeypatch
):
    """When the ES `index` call raises, the endpoint surfaces 503."""
    from api.routes import applications as apps_route

    real_get_client = apps_route.get_client

    class FailingClient:
        def search(self, *a, **kw):
            return {"hits": {"hits": []}}

        def index(self, *a, **kw):
            raise RuntimeError("simulated ES outage")

    monkeypatch.setattr(apps_route, "get_client", lambda: FailingClient())
    try:
        resp = client.post(
            "/api/applications", json=_payload(email="fail@example.com")
        )
        assert resp.status_code == 503
        assert resp.json()["detail"] == "application_storage_unavailable"
    finally:
        monkeypatch.setattr(apps_route, "get_client", real_get_client)
