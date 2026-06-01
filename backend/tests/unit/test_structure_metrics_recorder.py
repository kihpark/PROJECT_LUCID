"""Unit: record_structure_metrics + anonymization invariants (PR-3-3 D)."""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from api.metrics.precision import record_structure_metrics
from api.storage.postgres.orm import StructureMetricsLog


def test_record_structure_metrics_writes_row():
    session = MagicMock()
    captured: list = []
    session.add.side_effect = lambda row: captured.append(row)

    uid = uuid.uuid4()
    job_id = uuid.uuid4()
    row_id = record_structure_metrics(
        session,
        user_id=uid,
        source_job_id=job_id,
        fact_count=5,
        object_count_auto=2,
        object_count_new=1,
        object_count_disambig=0,
        link_count=8,
        negates_count=1,
        decomposer_model="claude-sonnet-4-5",
        latency_ms=4200,
    )
    assert len(captured) == 1
    row = captured[0]
    assert isinstance(row, StructureMetricsLog)
    assert row.user_id == uid
    assert row.source_job_id == job_id
    assert row.fact_count == 5
    assert row.object_count_auto == 2
    assert row.object_count_new == 1
    assert row.object_count_disambig == 0
    assert row.link_count == 8
    assert row.negates_count == 1
    assert row.decomposer_model == "claude-sonnet-4-5"
    assert row.latency_ms == 4200
    session.flush.assert_called_once()
    # Returned id is the row's id attribute (may be None pre-flush in real DB).
    assert row_id is row.id or row_id is None


def test_structure_metrics_log_has_no_pii_columns():
    """DCR-001 invariant: the table stores ONLY counts + model + latency.

    The table must not have any of: claim text, source url, object names,
    fact ids, raw payload — these would re-introduce PII into telemetry."""
    cols = {c.name for c in StructureMetricsLog.__table__.columns}

    banned = {
        "claim_text", "claim", "fact_text",
        "source_url", "url",
        "object_name", "object_names", "name",
        "fact_uid", "object_uid",
        "raw_payload", "extracted_text",
    }
    assert banned.isdisjoint(cols), (
        f"PII column leaked into structure_metrics_logs: "
        f"{banned & cols}"
    )

    # Required column set (positive control).
    required = {
        "id", "user_id", "source_job_id",
        "fact_count", "object_count_auto", "object_count_new",
        "object_count_disambig", "link_count", "negates_count",
        "decomposer_model", "latency_ms", "logged_at",
    }
    assert required.issubset(cols), f"missing required columns: {required - cols}"


def test_structure_metrics_log_check_constraint_blocks_negatives():
    """The CHECK constraint enforces non-negative counts."""
    ck = next(
        c for c in StructureMetricsLog.__table__.constraints
        if hasattr(c, "name") and c.name == "ck_structure_metrics_nonneg"
    )
    sql = str(ck.sqltext)
    for col in (
        "fact_count", "object_count_auto", "object_count_new",
        "object_count_disambig", "link_count", "negates_count",
    ):
        assert col in sql, f"{col} missing from non-negative CHECK"
