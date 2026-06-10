"""Unit: Validate request/response shapes + ValidationLog invariants."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timezone
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from api.metrics.precision import record_validation_decision
from api.models.validate import (
    DecideRequest,
    DecideResponse,
    DisambigEntry,
    DisambigResolveRequest,
    FactDecision,
    GraphNoteCreateRequest,
    ObjectDecision,
    PendingFilters,
    PendingJobDetail,
)
from api.storage.postgres.orm import ValidationLog


# ---------------------------------------------------------------------------
# Pydantic request shapes
# ---------------------------------------------------------------------------
def test_pending_filters_all_optional():
    """Every filter field is optional — empty filter is a valid request."""
    f = PendingFilters()
    assert f.source_url is None
    assert f.has_negation_flag is None


def test_fact_decision_accept_does_not_require_edited_claim():
    d = FactDecision(fact_uid="fn-1", action="accept")
    assert d.edited_claim is None


def test_fact_decision_rejects_unknown_action():
    with pytest.raises(ValidationError):
        FactDecision(fact_uid="fn-1", action="explode")


def test_object_decision_accepts_three_actions():
    for a in ("create_new", "merge_with", "skip"):
        o = ObjectDecision(candidate_id="obj-1", action=a)
        assert o.action == a


def test_decide_request_empty_lists_ok():
    """An empty decide request shouldn't raise — caller may decide nothing."""
    r = DecideRequest()
    assert r.decisions == []
    assert r.object_decisions == []


def test_decide_response_default_zero_logs():
    r = DecideResponse(validation_log_count=0)
    assert r.validation_log_count == 0
    assert r.accepted_facts == []


def test_disambig_resolve_request_rejects_bad_action():
    with pytest.raises(ValidationError):
        DisambigResolveRequest(action="bogus")


def test_disambig_entry_round_trips_candidates():
    e = DisambigEntry(
        disambig_id="job:llm-1", job_id="job",
        candidate_name="X",
        decision_reason="exact_match_multi",
        candidates=[{"object_uid": "obj-1", "name": "X", "score": 1.0}],
    )
    assert len(e.candidates) == 1


def test_graph_note_create_rejects_empty_text():
    with pytest.raises(ValidationError):
        GraphNoteCreateRequest(note="")


def test_graph_note_create_caps_at_8000_chars():
    with pytest.raises(ValidationError):
        GraphNoteCreateRequest(note="x" * 8001)


# ---------------------------------------------------------------------------
# record_validation_decision
# ---------------------------------------------------------------------------
def test_record_validation_decision_writes_row():
    session = MagicMock()
    captured: list = []
    session.add.side_effect = lambda row: captured.append(row)

    uid = uuid.uuid4()
    job_id = uuid.uuid4()
    record_validation_decision(
        session, user_id=uid, validator_id=uid,
        source_job_id=job_id, fact_uid="fn-1", object_uid=None,
        action="edit", edited_claim_len=42,
        decision_metadata={"hint": "x"},
    )
    assert len(captured) == 1
    row = captured[0]
    assert isinstance(row, ValidationLog)
    assert row.action == "edit"
    assert row.edited_claim_len == 42
    assert row.fact_uid == "fn-1"
    session.flush.assert_called_once()


def test_validation_log_has_no_claim_text_column():
    """DCR-001 invariant: claim text NEVER lands in validation_logs."""
    cols = {c.name for c in ValidationLog.__table__.columns}
    banned = {
        "claim", "claim_text", "edited_claim", "source_url",
        "object_name", "fact_text", "raw_payload",
    }
    assert banned.isdisjoint(cols), (
        f"PII column leaked into validation_logs: {banned & cols}"
    )
    required = {
        "id", "user_id", "validator_id", "source_job_id",
        "fact_uid", "object_uid", "action",
        "edited_claim_len", "validated_at", "decision_metadata",
    }
    assert required.issubset(cols), f"missing: {required - cols}"


def test_validation_log_check_constraint_blocks_unknown_action():
    """The CHECK clause enumerates exactly the 8 actions we support."""
    ck = next(
        c for c in ValidationLog.__table__.constraints
        if hasattr(c, "name") and c.name == "ck_validation_logs_action"
    )
    sql = str(ck.sqltext)
    for a in (
        "accept", "edit", "discard",
        "merge_with", "create_new", "skip",
        "accept_all", "discard_job",
    ):
        assert f"'{a}'" in sql


def test_pending_job_detail_carries_decided_fact_uids_field():
    """chore 7 — PendingJobDetail surface gains decided_fact_uids."""
    d = PendingJobDetail(
        job_id="job-1",
        source_url="https://example.com",
        source_type="web_article",
        captured_at=datetime.now(UTC),
        captured_from="chrome_ext",
        knowledge_space_id="ks-1",
        extracted_text_preview="...",
        facts=[],
        decided_fact_uids=["fn-1", "fn-2"],
    )
    assert d.decided_fact_uids == ["fn-1", "fn-2"]
    # Round-trip through model_dump for the FastAPI response surface.
    dumped = d.model_dump(mode="json")
    assert dumped["decided_fact_uids"] == ["fn-1", "fn-2"]


def test_pending_job_detail_default_decided_fact_uids_is_empty():
    """chore 7 — back-compat with clients that don't send the field."""
    d = PendingJobDetail(
        job_id="job-1",
        source_url="https://example.com",
        source_type="web_article",
        captured_at=datetime.now(UTC),
        captured_from="chrome_ext",
        knowledge_space_id="ks-1",
        extracted_text_preview="...",
    )
    assert d.decided_fact_uids == []
