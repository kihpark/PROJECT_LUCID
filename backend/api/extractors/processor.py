"""Extract a SourceJob — entry point for the BackgroundTasks worker.

`process_source_job(job_id)` is called by FastAPI's BackgroundTasks
after /api/capture returns 202. It runs the dispatcher against the
job's raw_payload + metadata and writes the result back to the row:

  pending_extract --(lock)--> extracting --(dispatch)--> extracted
                                                  + extract_failed (fail branch)

Idempotency
-----------
A job in `extracted` or `extract_failed` is final; re-invoking with the
same `job_id` is a no-op. A job already in `extracting` is left alone
(another worker is on it — in beta this only happens if the user
restarts the server mid-extract).

Locking
-------
The status transition `pending_extract` -> `extracting` is the lock.
Race condition is not possible in beta (single-process BackgroundTasks);
Phase 1+ distributed workers will need `FOR UPDATE SKIP LOCKED`.

Error policy
------------
Every exception inside `extract()` is caught. We classify into:
  ExtractorError / NoTranscriptError / UnknownSourceTypeError
    -> status='extract_failed', error_message=str(exc)
  any other exception
    -> status='extract_failed', error_message='Internal error: <type>'
    -> logged at ERROR level for the dev to find in the logs

A successful run does NOT enqueue the Structure step — that's Sprint 3.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from api.extractors.base import ExtractorError, ExtractResult
from api.extractors.dispatcher import extract as dispatch_extract
from api.models.source import SourceType
from api.models.source_job import SourceStatus
from api.storage.postgres.compression import decompress_payload
from api.storage.postgres.orm import SourceJobORM
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.extractors.processor")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _build_metadata(job: SourceJobORM) -> dict[str, Any]:
    """Translate the SourceJob row into the metadata dict the extractors expect."""
    meta: dict[str, Any] = {
        "source_url": job.source_url,
        "source_type": job.source_type,
        "captured_from": job.captured_from,
        "captured_at": job.captured_at,
        "knowledge_space_id": str(job.knowledge_space_id),
    }
    if job.client_metadata:
        meta.update(job.client_metadata)
    return meta


def process_source_job(job_id: uuid.UUID | str) -> None:
    """Background task entry point. Safe to call with a missing job_id."""
    if isinstance(job_id, str):
        try:
            job_id = uuid.UUID(job_id)
        except ValueError:
            logger.warning("process_source_job: invalid job_id=%r", job_id)
            return

    session = make_sessionmaker()()
    try:
        job: SourceJobORM | None = session.get(SourceJobORM, job_id)
        if job is None:
            logger.info("process_source_job: job %s not found; skipping", job_id)
            return

        if job.status not in (
            SourceStatus.PENDING_EXTRACT.value,
            SourceStatus.EXTRACTING.value,
        ):
            logger.info(
                "process_source_job: job %s already in terminal state %s; skipping",
                job_id,
                job.status,
            )
            return
        if job.status == SourceStatus.EXTRACTING.value:
            logger.info(
                "process_source_job: job %s already extracting; skipping",
                job_id,
            )
            return

        # Lock-by-status: pending_extract -> extracting
        job.status = SourceStatus.EXTRACTING.value
        job.updated_at = _utc_now()
        session.commit()

        # Pull the bytes back out
        compressed = job.raw_payload or b""
        raw = decompress_payload(compressed)
        metadata = _build_metadata(job)

        try:
            source_type = SourceType(job.source_type)
        except ValueError:
            logger.exception("process_source_job: unknown source_type on job %s", job_id)
            _record_failure(session, job, f"Unsupported source type: {job.source_type}")
            return

        try:
            result: ExtractResult = dispatch_extract(
                raw, metadata, source_type=source_type
            )
        except ExtractorError as exc:
            logger.info(
                "process_source_job: job %s extract failed (ExtractorError): %s",
                job_id,
                exc,
            )
            _record_failure(session, job, str(exc) or type(exc).__name__)
            return
        except Exception as exc:  # noqa: BLE001 - never let a worker crash
            logger.exception("process_source_job: unhandled error on job %s", job_id)
            _record_failure(
                session,
                job,
                f"Internal error: {type(exc).__name__}",
            )
            return

        # Success branch
        _record_success(session, job, result)
        # Sprint 3 PR-3-2: enqueue the structure stage on the same job.
        # Imported lazily so structure module is optional at import time.
        try:
            from api.structure.processor import process_extracted_job
            process_extracted_job(job.id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "process_extracted_job enqueue failed for job %s (extract still "
                "succeeded; structure can be retried manually)",
                job.id,
            )

    finally:
        session.close()


def _record_success(
    session: Any, job: SourceJobORM, result: ExtractResult
) -> None:
    """Persist the successful ExtractResult onto the SourceJob row."""
    job.status = SourceStatus.EXTRACTED.value
    job.extracted_text = result.merged_text
    job.extracted_metadata = result.extracted_metadata or {}
    job.extraction_warnings = list(result.extraction_warnings or [])
    job.extracted_at = _utc_now()
    job.updated_at = _utc_now()
    job.error_message = None
    session.commit()
    logger.info(
        "process_source_job: job %s extracted (%d chars, %d warnings)",
        job.id,
        len(result.merged_text or ""),
        len(result.extraction_warnings or []),
    )


def _record_failure(session: Any, job: SourceJobORM, message: str) -> None:
    """Persist a terminal extract_failed state with the error message."""
    job.status = SourceStatus.EXTRACT_FAILED.value
    job.error_message = (message or "")[:2000]  # SourceJob model caps at 2000
    job.extracted_at = None
    job.updated_at = _utc_now()
    session.commit()
