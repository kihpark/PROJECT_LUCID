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

A successful run dispatches the Structure stage to a daemon thread
(see `_enqueue_structure_async`). The extract BackgroundTask returns
as soon as status='extracted' is committed; Structure transitions
`extracted` -> `structuring` -> `structured` on its own thread.
For tests, set `_STRUCTURE_INLINE_FOR_TESTS = True` to run inline.
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
        # Sprint 3 PR-3-3: dispatch the Structure stage on a sibling
        # daemon thread so the extract BackgroundTask returns
        # immediately. The job's status transitions
        # extracted -> structuring -> structured on the new thread.
        _enqueue_structure_async(job.id)

    finally:
        session.close()


def _record_success(
    session: Any, job: SourceJobORM, result: ExtractResult
) -> None:
    """Persist the successful ExtractResult onto the SourceJob row.

    pending-card-title-date: ExtractResult.title used to be dropped on
    the floor here — only result.extracted_metadata (a side-channel
    dict the extractor builds for strategy stats) was persisted, while
    the canonical title field disappeared between extract and the
    Pending Queue's /pending list response. We now fold title /
    author / publish_date into extracted_metadata so the validate
    route's `_resolve_title` can read them back without a separate
    column or a JOIN.
    """
    job.status = SourceStatus.EXTRACTED.value
    job.extracted_text = result.merged_text
    metadata = dict(result.extracted_metadata or {})
    if result.title and "title" not in metadata:
        metadata["title"] = result.title
    if result.author and "author" not in metadata:
        metadata["author"] = result.author
    if result.publish_date and "publish_date" not in metadata:
        # ISO string — JSONB rejects datetime objects in some drivers.
        metadata["publish_date"] = result.publish_date.isoformat()
    job.extracted_metadata = metadata
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


# ---------------------------------------------------------------------------
# Structure-stage dispatch (Sprint 3 PR-3-3)
# ---------------------------------------------------------------------------
# `_STRUCTURE_INLINE_FOR_TESTS` is monkeypatched True inside tests so that
# the structure stage runs on the calling thread and is observable
# synchronously. In production the default (False) spawns a daemon
# `threading.Thread` so the extract BackgroundTask completes immediately
# and the client's /jobs/{id} poll sees status='extracted' between
# extract and structure. Phase 1+ swaps this for a Celery task.

_STRUCTURE_INLINE_FOR_TESTS: bool = False


def _enqueue_structure_async(job_id: uuid.UUID) -> None:
    """Dispatch `process_extracted_job(job_id)` on a daemon thread.

    Failures inside the structure stage do NOT roll back the extract
    success. The structure stage records its own terminal state
    (`structured` / `structure_failed`).
    """
    try:
        from api.structure.processor import process_extracted_job
    except ImportError as exc:
        logger.warning(
            "structure module not importable (job %s): %s; "
            "extract succeeded but structure will not run",
            job_id, exc,
        )
        return

    if _STRUCTURE_INLINE_FOR_TESTS:
        try:
            process_extracted_job(job_id)
        except Exception:  # noqa: BLE001 - never raise out
            logger.exception(
                "process_extracted_job (inline) failed for job %s", job_id,
            )
        return

    import threading
    t = threading.Thread(
        target=_structure_worker_safe,
        args=(job_id,),
        name=f"lucid-structure-{job_id}",
        daemon=True,
    )
    t.start()


def _structure_worker_safe(job_id: uuid.UUID) -> None:
    """Thread entry point. Swallows exceptions so the daemon thread
    exits quietly — failures are already recorded by the structure
    processor itself on the SourceJob row."""
    try:
        from api.structure.processor import process_extracted_job
        process_extracted_job(job_id)
    except Exception:  # noqa: BLE001
        logger.exception(
            "structure worker thread crashed for job %s", job_id,
        )
