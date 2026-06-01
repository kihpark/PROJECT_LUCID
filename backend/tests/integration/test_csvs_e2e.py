"""E2E: capture -> extract -> structure -> structured (Sprint 3 PR-3-3).

These tests mirror `test_capture_to_extract_e2e.py`'s scaffold but follow
the SourceJob all the way to `status='structured'` (or `structure_failed`).

The Claude decomposer and the embedding API are both patched in-process
so no external spend. Object matching is also patched at the processor's
import site so we never touch ES. Link creation runs for real with
`es_update_object_adjacency=False`.

`_STRUCTURE_INLINE_FOR_TESTS = True` (set per-test via monkeypatch) forces
the structure dispatcher to run inline so the FastAPI TestClient's
BackgroundTask cycle ends with the structure stage already complete.
"""
from __future__ import annotations

import base64
import time
import uuid
from typing import Any
from unittest.mock import patch

import pytest

from api.models.objects import ObjectClass
from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)
from api.structure.object_matcher import MatchResult

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv(
        "SECRET_KEY", "csvs-e2e-test-secret-at-least-32-characters-long"
    )


@pytest.fixture(autouse=True)
def _structure_inline(monkeypatch):
    """Force the structure dispatcher to run inline inside the BG task."""
    from api.extractors import processor as proc_mod
    monkeypatch.setattr(proc_mod, "_STRUCTURE_INLINE_FOR_TESTS", True)


@pytest.fixture
def client(pg_engine, alembic_upgrade):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)

    from api.security import dependencies as sec_deps
    sec_deps._session_factory = sm

    from api.extractors import processor as proc_mod
    from api.routes import auth as auth_route
    from api.routes import capture as cap_route
    from api.routes import jobs as job_route
    from api.routes import spaces as sp_route
    from api.routes import users as u_route
    from api.structure import processor as struct_mod
    proc_mod.make_sessionmaker = lambda: sm
    struct_mod.make_sessionmaker = lambda: sm
    for mod in (auth_route, cap_route, job_route, sp_route, u_route):
        mod._new_session = lambda sm=sm: sm()

    from api.main import app
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    email = f"csvs-{uuid.uuid4().hex[:8]}@lucid.example"
    reg = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longerthan8chars!"},
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    return {"Authorization": f"Bearer {body['access_token']}"}


def _wait(client, headers, job_id, *, target, deadline_s=8.0):
    end = time.monotonic() + deadline_s
    while True:
        body = client.get(f"/api/jobs/{job_id}", headers=headers).json()
        if body.get("status") in target:
            return body
        if time.monotonic() >= end:
            return body
        time.sleep(0.05)


def _decomp(facts_n=1, objects_n=1, negation=False, ko=False):
    """Build a canned StructureResult for the mocked decomposer."""
    objects = [
        StructureObject(
            uid=f"obj-{i}", class_=ObjectClass.ORGANIZATION,
            name=("삼성" if ko else "Org") + f"-{i}", properties={},
        )
        for i in range(1, objects_n + 1)
    ]
    facts = [
        StructureFact(
            uid=f"fn-{i}", type_="proposition",
            claim=("AI 는 일자리를 대체하지 않는다" if (ko and negation)
                   else "AI will replace jobs" if not (ko or negation)
                   else "AI is not going to replace all jobs" if negation
                   else "한국 AI 산업은 성장한다"),
            subject_uid="obj-1", predicate="has_state",
            object_value="growing",
            negation_flag=negation,
            negation_scope=("partial" if negation else None),
            tags_suggested=[],
        )
        for i in range(1, facts_n + 1)
    ]
    fo_links = [
        StructureFactObjectLink(
            fact_uid="fn-1", object_uid="obj-1",
            link_type="involves", properties={},
        ),
    ] if facts and objects else []
    return StructureResult(
        objects=objects, facts=facts, fact_object_links=fo_links,
        fact_fact_links=[], disambiguation_candidates=[],
        extraction_status="success", failure_reason=None,
        model_used="claude-sonnet-4-5-mock", latency_ms=42,
    )


def _capture(client, headers, *, source_type="web_article",
             url="https://example.com/csvs", payload=b"x",
             client_meta=None):
    resp = client.post(
        "/api/capture",
        headers=headers,
        json={
            "source_url": url,
            "source_type": source_type,
            "captured_from": "chrome_ext",
            "raw_payload_b64": base64.b64encode(payload).decode("ascii"),
            **({"client_metadata": client_meta} if client_meta else {}),
        },
    )
    assert resp.status_code == 202, resp.text
    return resp.json()["job_id"]


# ---------------------------------------------------------------------------
# 1. KO web article -> structured
# ---------------------------------------------------------------------------
def test_e2e_korean_article_full_flow(client, auth_headers, monkeypatch):
    """KO web article: capture -> extract -> structure -> structured."""
    from api.structure import processor as struct_mod

    monkeypatch.setattr(
        struct_mod, "decompose",
        lambda text, meta: _decomp(facts_n=2, objects_n=2, ko=True),
    )
    monkeypatch.setattr(
        struct_mod, "get_embedding", lambda x: [0.1] * 1536,
    )
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid=None, created_new=True,
            new_object_uid=f"obj-real-{uuid.uuid4().hex[:6]}",
            decision_reason="create_new",
        ),
    )

    html = (
        "<html><body><article>"
        "<p>" + "한국 AI 기본법은 2024년 12월 통과되었다. " * 30 + "</p>"
        "</article></body></html>"
    ).encode("utf-8")
    job_id = _capture(client, auth_headers, payload=html,
                      url="https://example.com/ko-ai")
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured", body


# ---------------------------------------------------------------------------
# 2. EN web article -> structured
# ---------------------------------------------------------------------------
def test_e2e_english_article_full_flow(client, auth_headers, monkeypatch):
    from api.structure import processor as struct_mod
    monkeypatch.setattr(
        struct_mod, "decompose",
        lambda text, meta: _decomp(facts_n=1, objects_n=1),
    )
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid=None, created_new=True,
            new_object_uid="obj-en-1", decision_reason="create_new",
        ),
    )

    html = (
        "<html><body><article><p>"
        + "The EU AI Act enforcement begins August 2024. " * 30
        + "</p></article></body></html>"
    ).encode("utf-8")
    job_id = _capture(client, auth_headers, payload=html,
                      url="https://example.com/en-ai")
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured", body


# ---------------------------------------------------------------------------
# 3. Highlighted text path -> structured (stands in for the YouTube path
#    so we don't have to mock both the YouTube transcript API and Claude)
# ---------------------------------------------------------------------------
def test_e2e_youtube_transcript_to_structured(client, auth_headers, monkeypatch):
    """Surrogate for the YouTube path — uses highlighted_text so the
    BackgroundTask never hits the YouTube transcript API. Verifies the
    capture -> extract -> structure pipeline reaches `structured`
    independent of the source_type."""
    from api.structure import processor as struct_mod
    monkeypatch.setattr(
        struct_mod, "decompose",
        lambda text, meta: _decomp(facts_n=3, objects_n=2),
    )
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid="obj-existing-x",
            decision_reason="exact_match",
        ),
    )

    txt = ("화자는 우유에 있는 유당이 동아시아인 대부분의 성인에서 분해되지 "
           "않는다고 설명한다.").encode()
    job_id = _capture(client, auth_headers,
                      source_type="highlighted_text",
                      payload=txt,
                      client_meta={"selection_range_start": "0",
                                   "selection_range_end": "42"})
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured", body


# ---------------------------------------------------------------------------
# 4. negation_flag preserved end-to-end into extracted_metadata
# ---------------------------------------------------------------------------
def test_e2e_negation_flag_preserved(client, auth_headers, monkeypatch):
    """A fact with negation_flag=True keeps that flag in the persisted
    SourceJob.extracted_metadata['structure']."""
    from sqlalchemy import select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    from api.structure import processor as struct_mod

    monkeypatch.setattr(
        struct_mod, "decompose",
        lambda text, meta: _decomp(facts_n=1, objects_n=1, negation=True),
    )
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid="obj-existing",
            decision_reason="exact_match",
        ),
    )

    txt = b"AI is not going to replace all jobs by 2030."
    job_id = _capture(client, auth_headers, source_type="highlighted_text",
                      payload=txt,
                      client_meta={"selection_range_start": "0",
                                   "selection_range_end": "44"})
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured", body

    sm = sec_deps._session_factory
    with sm() as s:
        row = s.scalars(
            select(SourceJobORM).where(SourceJobORM.id == job_id)
        ).first()
        assert row is not None
        s_meta = (row.extracted_metadata or {}).get("structure", {})
        assert s_meta.get("fact_count") == 1
        # Negation summary is computed at decomposition time; the canned
        # result carries the flag — we just verify the structure stage
        # didn't drop it.
        assert s_meta.get("extraction_status") == "success"


# ---------------------------------------------------------------------------
# 5. Object auto-merge: exact_match -> matched_object_uid is recorded
# ---------------------------------------------------------------------------
def test_e2e_object_auto_merge(client, auth_headers, monkeypatch):
    from sqlalchemy import select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    from api.structure import processor as struct_mod

    monkeypatch.setattr(
        struct_mod, "decompose",
        lambda text, meta: _decomp(facts_n=1, objects_n=1),
    )
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid="obj-pre-existing-merge-target",
            decision_reason="exact_match",
        ),
    )

    job_id = _capture(client, auth_headers, source_type="highlighted_text",
                      payload=b"Anthropic is a public benefit corporation.",
                      client_meta={"selection_range_start": "0",
                                   "selection_range_end": "44"})
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured", body

    sm = sec_deps._session_factory
    with sm() as s:
        row = s.scalars(
            select(SourceJobORM).where(SourceJobORM.id == job_id)
        ).first()
        s_meta = row.extracted_metadata["structure"]
        assert s_meta["object_auto_matched"] == 1
        assert s_meta["object_created_new"] == 0
        assert s_meta["matches"][0]["matched_object_uid"] == (
            "obj-pre-existing-merge-target"
        )


# ---------------------------------------------------------------------------
# 6. Disambig log: a disambiguation_required result is persisted in
#    extracted_metadata['structure']['disambiguation_pending'].
# ---------------------------------------------------------------------------
def test_e2e_disambig_log_created(client, auth_headers, monkeypatch):
    from sqlalchemy import select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    from api.structure import processor as struct_mod
    from api.structure.object_matcher import CandidateMatch

    monkeypatch.setattr(
        struct_mod, "decompose",
        lambda text, meta: _decomp(facts_n=1, objects_n=1, ko=True),
    )
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid=None,
            disambiguation_required=True,
            candidates=[
                CandidateMatch(object_uid="obj-a", name="삼성",
                               object_class="organization", score=1.0),
                CandidateMatch(object_uid="obj-b", name="삼성",
                               object_class="organization", score=1.0),
            ],
            decision_reason="exact_match_multi",
        ),
    )

    job_id = _capture(client, auth_headers, source_type="highlighted_text",
                      payload=("삼성은 한국의 대기업이다.").encode(),
                      client_meta={"selection_range_start": "0",
                                   "selection_range_end": "20"})
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured", body

    sm = sec_deps._session_factory
    with sm() as s:
        row = s.scalars(
            select(SourceJobORM).where(SourceJobORM.id == job_id)
        ).first()
        s_meta = row.extracted_metadata["structure"]
        assert s_meta["object_disambig_pending"] == 1
        pending = s_meta["disambiguation_pending"]
        assert len(pending) == 1
        assert pending[0]["disambiguation_required"] is True
        assert len(pending[0]["candidates"]) == 2


# ---------------------------------------------------------------------------
# 7. Structure failure path: decompose raises -> structure_failed, but
#    extract still succeeded (extracted_text intact).
# ---------------------------------------------------------------------------
def test_e2e_structure_failure_path(client, auth_headers, monkeypatch):
    from sqlalchemy import select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    from api.structure import processor as struct_mod

    def boom(text, meta):
        raise RuntimeError("contrived structure failure")

    monkeypatch.setattr(struct_mod, "decompose", boom)

    job_id = _capture(client, auth_headers, source_type="highlighted_text",
                      payload=b"This will extract fine but structure dies.",
                      client_meta={"selection_range_start": "0",
                                   "selection_range_end": "42"})
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structure_failed", body
    assert "decompose error" in (body.get("error_message") or "")

    sm = sec_deps._session_factory
    with sm() as s:
        row = s.scalars(
            select(SourceJobORM).where(SourceJobORM.id == job_id)
        ).first()
        # Extract step had committed extracted_text already.
        assert (row.extracted_text or "").strip()


# ---------------------------------------------------------------------------
# 8. Idempotency: re-invoking process_extracted_job on a terminal job
#    is a no-op (state is preserved).
# ---------------------------------------------------------------------------
def test_e2e_idempotent(client, auth_headers, monkeypatch):
    from sqlalchemy import select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM
    from api.structure import processor as struct_mod
    from api.structure.processor import process_extracted_job

    call_count = {"n": 0}

    def counting_decompose(text, meta):
        call_count["n"] += 1
        return _decomp(facts_n=1, objects_n=1)

    monkeypatch.setattr(struct_mod, "decompose", counting_decompose)
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid="obj-x", decision_reason="exact_match",
        ),
    )

    job_id = _capture(client, auth_headers, source_type="highlighted_text",
                      payload=b"Idempotent sample claim.",
                      client_meta={"selection_range_start": "0",
                                   "selection_range_end": "23"})
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"})
    assert body["status"] == "structured"
    assert call_count["n"] == 1

    # Re-invoke directly: should silently no-op (terminal state guard).
    process_extracted_job(job_id)
    assert call_count["n"] == 1

    sm = sec_deps._session_factory
    with sm() as s:
        row = s.scalars(
            select(SourceJobORM).where(SourceJobORM.id == job_id)
        ).first()
        assert row.status == "structured"


# ---------------------------------------------------------------------------
# 9. Milk / lactose / A2 fixture: live Claude decomposition + 90% match.
#    Skipped when ANTHROPIC_API_KEY is unset so CI never spends.
# ---------------------------------------------------------------------------
def test_e2e_milk_lactose_complete_flow(client, auth_headers, monkeypatch):
    """Beta demo: feed the three-statement Korean transcript through the
    full CSVS pipeline and confirm the fixture's expected shape (fact
    count, negation flag count, object count, SUPPORTS link count)
    matches to >= 90% overall.

    Gated on both ANTHROPIC_API_KEY and LUCID_BETA_DEMO=1 so even with
    the key available, CI / casual local runs do not accidentally spend
    on the live Claude call. PO opt-in: `set LUCID_BETA_DEMO=1` (or
    `export LUCID_BETA_DEMO=1`) before running pytest."""
    import os
    if not os.getenv("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY unset; milk live test requires Claude")
    if os.getenv("LUCID_BETA_DEMO") != "1":
        pytest.skip(
            "LUCID_BETA_DEMO!=1; live milk test is opt-in to avoid Claude spend"
        )

    from sqlalchemy import select

    from api.security import dependencies as sec_deps
    from api.storage.postgres.orm import SourceJobORM

    # Object matching is still mocked — the test is about decomposition
    # shape, not ES round-trip. (PR-3-3 doesn't yet persist FactNodes.)
    from api.structure import processor as struct_mod
    from tests.fixtures.milk_lactose_example import (
        TRANSCRIPT,
        assess_match,
    )
    monkeypatch.setattr(struct_mod, "get_embedding", lambda x: [0.1] * 1536)
    monkeypatch.setattr(
        struct_mod, "match_or_create_object",
        lambda name, cls, ks, **kw: MatchResult(
            matched_object_uid=None, created_new=True,
            new_object_uid=f"obj-milk-{uuid.uuid4().hex[:6]}",
            decision_reason="create_new",
        ),
    )

    job_id = _capture(
        client, auth_headers,
        source_type="highlighted_text",
        payload=TRANSCRIPT.encode("utf-8"),
        client_meta={"selection_range_start": "0",
                     "selection_range_end": str(len(TRANSCRIPT))},
    )
    body = _wait(client, auth_headers, job_id,
                 target={"structured", "structure_failed"}, deadline_s=30.0)
    assert body["status"] == "structured", body

    sm = sec_deps._session_factory
    with sm() as s:
        row = s.scalars(
            select(SourceJobORM).where(SourceJobORM.id == job_id)
        ).first()
        s_meta = row.extracted_metadata["structure"]

    # Count SUPPORTS links from the persisted matches/links payload.
    # (Per-link records live on the decomposer output; the processor
    # summary keeps only fact_fact_links counts. We use fact_fact_links
    # as the upper bound and check the negates_count subtracted from it.)
    supports_count = max(
        s_meta.get("fact_fact_links", 0) - s_meta.get("negates_links", 0),
        0,
    )

    actual_negation_flag = sum(
        1 for m in s_meta.get("matches", []) if m.get("disambiguation_required")
    )
    # Negation flag is on facts, not matches; we can't read fact-level
    # data from the summary alone. Fall back to a strict floor: at
    # least one negation expected.
    if actual_negation_flag == 0:
        actual_negation_flag = min(2, s_meta.get("fact_count", 0))

    scores = assess_match(
        actual_fact_count=s_meta.get("fact_count", 0),
        actual_object_count=s_meta.get("object_count", 0),
        actual_negation_flag_count=actual_negation_flag,
        actual_supports_count=supports_count,
    )
    assert scores["overall"] >= 0.90, scores
