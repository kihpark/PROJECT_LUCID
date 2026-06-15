"""POST /api/capture — Sprint 2C PR-2C-1.

Accepts a CaptureRequest, creates a SourceJob row (status=pending_extract),
schedules an extractor via FastAPI BackgroundTasks, and returns 202 with
the job_id + a status_url for polling.

Source policy lookup (Trusted/Careful per Settings SET-2 → PO directive
[변경 3]): the request itself does NOT carry the policy; the server
looks up source_policies by (user_id, domain) at capture time and stamps
the resolved policy onto the SourceJob row so the audit trail records
*what the policy was when this capture happened* (immutable history).

Extractor runner is wired in PR-2C-3 (api/extractors/processor.py).
This PR just makes the API contract live + the row land.
"""
from __future__ import annotations

import base64
import binascii
import logging
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from api.models.source_job import (
    CaptureRequest,
    CaptureResponse,
    SourceStatus,
)
from api.security import get_current_user
from api.storage.postgres.compression import (
    MAX_PRECOMPRESSION_BYTES,
    compress_payload,
)
from api.storage.postgres.orm import KnowledgeSpace, SourceJobORM, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.capture")

router = APIRouter(prefix="/api", tags=["capture"])


def _new_session() -> Session:
    return make_sessionmaker()()


def _resolve_knowledge_space(
    session: Session, user: User, requested: uuid.UUID | None
) -> KnowledgeSpace:
    """Either use the requested space (with ownership check) or the
    user's default Personal space."""
    if requested is not None:
        ks = session.get(KnowledgeSpace, requested)
        if ks is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="space_not_found"
            )
        if ks.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="forbidden"
            )
        return ks
    # Default = first Personal space
    ks = (
        session.query(KnowledgeSpace)
        .filter(KnowledgeSpace.user_id == user.id, KnowledgeSpace.type == "personal")
        .first()
    )
    if ks is None:
        raise HTTPException(
            status_code=status.HTTP_412_PRECONDITION_FAILED,
            detail="no_default_space",
        )
    return ks


def _resolve_policy(session: Session, user: User, source_url: str) -> str:
    """Look up the per-domain policy from Settings SET-2. Default 'careful'."""
    try:
        domain = urlparse(source_url).netloc.lower() or source_url
    except ValueError:
        return "careful"
    from api.storage.postgres.orm import SourcePolicyORM

    row = (
        session.query(SourcePolicyORM)
        .filter(
            SourcePolicyORM.user_id == user.id,
            SourcePolicyORM.source_domain == domain,
        )
        .first()
    )
    return row.policy if row is not None else "careful"


def _enqueue_extract(job_id: uuid.UUID) -> None:
    """BackgroundTasks entry point — call the real processor.

    PR-2C-3 wired this to `process_source_job` (in
    `api.extractors.processor`). Imported lazily to keep the route
    module's startup imports light and to make the call site easy to
    monkey-patch in unit tests.
    """
    from api.extractors.processor import process_source_job

    logger.info("BackgroundTasks: dispatching extract for source_job %s", job_id)
    process_source_job(job_id)


@router.post(
    "/capture",
    response_model=CaptureResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def capture(
    req: CaptureRequest,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
) -> CaptureResponse:
    """Accept a capture, create a SourceJob, schedule extraction."""
    session = _new_session()
    try:
        ks_uuid = (
            uuid.UUID(req.knowledge_space_id)
            if req.knowledge_space_id is not None
            else None
        )
        ks = _resolve_knowledge_space(session, user, ks_uuid)

        # B-29 defect 3 (policy i): if this user already has a job for
        # the same (knowledge_space, source_url) — at any status, even
        # already-fully-decided — refuse to create a second row.
        # Return the existing job_id with duplicate=True so the client
        # can route the user there instead of piling empty cards into
        # the queue. The (ii) re-analyse policy is deferred pending
        # PO sign-off.
        existing = (
            session.query(SourceJobORM)
            .filter(
                SourceJobORM.user_id == user.id,
                SourceJobORM.knowledge_space_id == ks.id,
                SourceJobORM.source_url == req.source_url,
            )
            .order_by(SourceJobORM.created_at.desc())
            .first()
        )
        if existing is not None:
            logger.info(
                "capture: duplicate suppressed user=%s ks=%s url=%s -> existing job %s",
                user.id, ks.id, req.source_url, existing.id,
            )
            return CaptureResponse(
                job_id=str(existing.id),
                status=SourceStatus(existing.status),
                status_url=f"/api/jobs/{existing.id}",
                duplicate=True,
            )

        policy = _resolve_policy(session, user, req.source_url)

        compressed: bytes | None = None
        if req.raw_payload_b64 is not None:
            try:
                raw = base64.b64decode(req.raw_payload_b64, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="raw_payload_b64_invalid",
                ) from exc
            if len(raw) > MAX_PRECOMPRESSION_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="raw_payload_too_large",
                )
            compressed = compress_payload(raw)

        job = SourceJobORM(
            user_id=user.id,
            knowledge_space_id=ks.id,
            source_url=req.source_url,
            source_type=req.source_type.value if hasattr(req.source_type, "value") else str(req.source_type),
            captured_from=req.captured_from,
            raw_payload=compressed,
            status=SourceStatus.PENDING_EXTRACT.value,
            policy_at_capture=policy,
            client_metadata=req.client_metadata,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id

        # Schedule the extractor. PR-2C-3 wires the real processor here.
        background_tasks.add_task(_enqueue_extract, job_id)

        return CaptureResponse(
            job_id=str(job_id),
            status=SourceStatus.PENDING_EXTRACT,
            status_url=f"/api/jobs/{job_id}",
        )
    finally:
        session.close()
