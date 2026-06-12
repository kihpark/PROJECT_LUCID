"""/api/jobs — Sprint 2C PR-2C-1.

GET /api/jobs/{job_id}   one SourceJob by id (403 if not owner)
GET /api/jobs/pending    list of caller's pending_* SourceJobs

Lifecycle states in scope for Sprint 2C only: pending_extract,
extracting, extracted, extract_failed. Sprint 3 adds the structure
states; this route's filter widens then.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from api.models.source_job import JobStatusResponse, SourceStatus
from api.security import get_current_user
from api.storage.postgres.orm import SourceJobORM, User
from api.storage.postgres.session import make_sessionmaker

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _new_session():
    return make_sessionmaker()()


def _to_response(job: SourceJobORM) -> JobStatusResponse:
    return JobStatusResponse(
        job_id=str(job.id),
        knowledge_space_id=str(job.knowledge_space_id),
        source_url=job.source_url,
        source_type=job.source_type,  # type: ignore[arg-type]
        status=SourceStatus(job.status),
        captured_at=job.captured_at,
        captured_from=job.captured_from,  # type: ignore[arg-type]
        error_message=job.error_message,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


# Literal-path routes MUST be declared before parametric routes that
# would otherwise swallow them. FastAPI registers routes in source
# order; /api/jobs/pending must be declared before /api/jobs/{job_id}
# or the UUID catch-all tries to parse "pending" and returns 422.
@router.get("/pending", response_model=list[JobStatusResponse])
def list_pending_jobs(user: User = Depends(get_current_user)) -> list[JobStatusResponse]:
    """Return all of the caller's source_jobs, newest first.

    The endpoint name "pending" reflects the user mental model
    ("the jobs I'm still tracking"), NOT the narrow
    `status IN ('pending_extract', 'extracting')` set. Every state
    the user might still want to act on — including extract_failed
    (retry candidate), structured (decide-overlay candidate), and
    structure_failed (retry candidate) — is in-scope.

    Cross-user isolation is enforced via `user_id` filter; another
    user's captures are never returned regardless of state.

    (Frontend currently consumes the Sprint 4B
    `GET /api/spaces/{sid}/pending` route for the validate UI;
    `/api/jobs/pending` exists for the chrome extension's "recent
    captures" lookups and the integration test suite.)
    """
    session = _new_session()
    try:
        rows = (
            session.query(SourceJobORM)
            .filter(SourceJobORM.user_id == user.id)
            .order_by(SourceJobORM.created_at.desc())
            .all()
        )
        return [_to_response(j) for j in rows]
    finally:
        session.close()


@router.get("/{job_id}", response_model=JobStatusResponse)
def get_job(
    job_id: uuid.UUID, user: User = Depends(get_current_user)
) -> JobStatusResponse:
    session = _new_session()
    try:
        job = session.get(SourceJobORM, job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job_not_found")
        if job.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return _to_response(job)
    finally:
        session.close()
