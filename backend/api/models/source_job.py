"""SourceJob — the unit of capture work in flight.

A SourceJob represents one user capture event (POST /api/capture) from
the moment the user clicks Save until the AtomicFacts settle in ES.
The lifecycle (Sprint 2C scope only — Sprint 3 adds 'pending_structure'
through 'structured'):

  pending_extract   accepted by /api/capture, queued for an extractor
  extracting        extractor is running
  extracted         merged_text ready; will move to Structure in Sprint 3
  extract_failed    extractor returned an error (recoverable by user)

`raw_payload` carries the original bytes (HTML, transcript, PDF, etc.)
gzip-compressed before storage. The compression helpers live in
`api/storage/postgres/compression.py`. Decompression only fires at
extraction time, so the cost is paid once per capture.

Privacy:
  - user_id has FK cascade so deleting the user wipes their jobs
  - raw_payload is per-user; never read across knowledge_space boundaries
  - 7-day TTL on raw_payload is a follow-up policy (separate PR)
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now
from api.models.source import SourceType


class SourceStatus(StrEnum):
    """SourceJob lifecycle states. Sprint 2C scope only — Sprint 3 extends."""

    PENDING_EXTRACT = "pending_extract"
    EXTRACTING = "extracting"
    EXTRACTED = "extracted"
    EXTRACT_FAILED = "extract_failed"


CapturedFrom = Literal["chrome_ext", "pwa_share", "api"]


class SourceJob(LucidBaseModel):
    """In-flight capture job. Persisted in Postgres `source_jobs`."""

    job_id: UID
    user_id: UID
    knowledge_space_id: UID
    source_url: str = Field(min_length=1, max_length=2048)
    source_type: SourceType
    captured_at: datetime = Field(default_factory=utc_now)
    captured_from: CapturedFrom
    status: SourceStatus = SourceStatus.PENDING_EXTRACT
    policy_at_capture: Literal["trusted", "careful"] = "careful"
    error_message: str | None = Field(default=None, max_length=2000)
    client_metadata: dict[str, str] | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class CaptureRequest(LucidBaseModel):
    """POST /api/capture request body.

    `raw_payload_b64` is the optional base64-encoded original bytes. The
    server gzip-compresses these before storage. Limit 5 MB pre-encoding
    (PDF caps tend to fit; larger PDFs must be reduced client-side).
    `knowledge_space_id` is optional; missing means "use my default
    Personal space".
    """

    source_url: str = Field(min_length=1, max_length=2048)
    source_type: SourceType
    captured_from: CapturedFrom
    knowledge_space_id: UID | None = None
    raw_payload_b64: str | None = None
    client_metadata: dict[str, str] | None = None


class CaptureResponse(LucidBaseModel):
    """202 response to POST /api/capture."""

    job_id: UID
    status: SourceStatus
    status_url: str  # e.g. "/api/jobs/{job_id}"


class JobStatusResponse(LucidBaseModel):
    """GET /api/jobs/{job_id} response."""

    job_id: UID
    knowledge_space_id: UID
    source_url: str
    source_type: SourceType
    status: SourceStatus
    captured_at: datetime
    captured_from: CapturedFrom
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


class ExtractedContent(LucidBaseModel):
    """Output of an extractor.

    PR-2C-3 wires this into a Postgres `source_jobs.extracted_text`
    column (per architect option A). For now the Pydantic shape is
    defined so PR-2C-2's extractors can use it.
    """

    source_job_id: UID
    merged_text: str
    title: str | None = None
    author: str | None = None
    publish_date: datetime | None = None
    language: Literal["ko", "en", "mixed"] = "mixed"
    extracted_metadata: dict[str, str] = Field(default_factory=dict)
    extraction_warnings: list[str] = Field(default_factory=list)
    extracted_at: datetime = Field(default_factory=utc_now)
