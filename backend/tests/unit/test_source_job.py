"""Unit: SourceJob model, SourceStatus enum, gzip helper, ORM table shape."""
from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from api.models.base import new_uid
from api.models.source_job import (
    CaptureRequest,
    CaptureResponse,
    JobStatusResponse,
    SourceJob,
    SourceStatus,
)
from api.storage.postgres.compression import (
    MAX_PRECOMPRESSION_BYTES,
    compress_payload,
    decompress_payload,
)


def test_source_status_has_eight_post_0018_values():
    """Sprint 2C shipped 4 extract values; Sprint 3 PR-3-2 added 3 structure
    values; fix/decide-status-transition (alembic 0018) added the terminal
    'validated' state; fix/sourcestatus-validated-enum closes the StrEnum gap."""
    assert set(SourceStatus) == {
        SourceStatus.PENDING_EXTRACT,
        SourceStatus.EXTRACTING,
        SourceStatus.EXTRACTED,
        SourceStatus.EXTRACT_FAILED,
        SourceStatus.STRUCTURING,
        SourceStatus.STRUCTURED,
        SourceStatus.STRUCTURE_FAILED,
        SourceStatus.VALIDATED,
    }


def test_source_job_pydantic_minimum():
    j = SourceJob(
        job_id=new_uid(),
        user_id=new_uid(),
        knowledge_space_id=new_uid(),
        source_url="https://example.com",
        source_type="web_article",
        captured_from="chrome_ext",
    )
    assert j.status == SourceStatus.PENDING_EXTRACT
    assert j.policy_at_capture == "careful"


def test_source_job_captured_from_rejects_unknown():
    with pytest.raises(ValidationError):
        SourceJob(
            job_id=new_uid(),
            user_id=new_uid(),
            knowledge_space_id=new_uid(),
            source_url="https://example.com",
            source_type="web_article",
            captured_from="fax_machine",
        )


def test_capture_request_required_fields():
    """source_url + source_type + captured_from are required."""
    with pytest.raises(ValidationError):
        CaptureRequest(source_url="x", source_type="web_article")  # type: ignore[call-arg]


def test_capture_response_carries_status_url():
    r = CaptureResponse(
        job_id=new_uid(),
        status=SourceStatus.PENDING_EXTRACT,
        status_url="/api/jobs/abc",
    )
    assert r.status_url.startswith("/api/jobs/")


def test_gzip_compress_decompress_roundtrip():
    raw = ("the quick brown fox " * 200).encode("utf-8")
    compressed = compress_payload(raw)
    assert len(compressed) < len(raw)
    assert decompress_payload(compressed) == raw


def test_gzip_compress_rejects_oversize():
    too_big = b"x" * (MAX_PRECOMPRESSION_BYTES + 1)
    with pytest.raises(ValueError, match="too large"):
        compress_payload(too_big)


def test_gzip_decompress_handles_empty_and_bad_input():
    assert decompress_payload(b"") == b""
    # If someone bypasses compress (legacy data) we return raw bytes,
    # never raise.
    assert decompress_payload(b"not-gzip-just-text") == b"not-gzip-just-text"


def test_source_job_orm_table_shape():
    """The ORM has the columns the migration creates."""
    from api.storage.postgres.orm import SourceJobORM

    cols = {c.name for c in SourceJobORM.__table__.columns}
    expected = {
        "id",
        "user_id",
        "knowledge_space_id",
        "source_url",
        "source_type",
        "captured_at",
        "captured_from",
        "raw_payload",
        "status",
        "policy_at_capture",
        "error_message",
        "client_metadata",
        "created_at",
        "updated_at",
    }
    assert expected.issubset(cols), f"missing: {expected - cols}"
