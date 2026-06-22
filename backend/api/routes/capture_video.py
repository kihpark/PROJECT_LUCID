"""POST /api/capture/video — B-46 PR1 video/audio STT capture adapter.

Accepts a video or audio URL, creates a SourceJob row with
``source_type=video_stt``, and dispatches the existing BackgroundTasks
→ extractor-processor → structure-thread chain (no new infra).

PR1 trade-off: the hard duration gate fires INSIDE the extractor
(async path) because we can't cheaply probe duration from a URL without
downloading. The route always returns 202 + job_id; the client polls
``/api/jobs/{job_id}`` and sees ``status=extract_failed`` with
``error_message`` starting ``"hard_limit_exceeded:"`` if the media
exceeds the configured limit. A pre-flight gate can be added in PR2
once we have a cheap HEAD-probe for duration.

Endpoints
---------
POST /api/capture/video
    JSON body: {url, knowledge_space_id?, language_hint?}
    → 202 VideoCaptureResponse
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, status
from pydantic import AnyUrl, Field

from api.models.base import LucidBaseModel
from api.models.source import SourceType
from api.models.source_job import SourceStatus
from api.routes.capture import (
    _enqueue_extract,
    _new_session,
    _resolve_knowledge_space,
    _resolve_policy,
)
from api.security import get_current_user
from api.storage.postgres.orm import SourceJobORM, User

logger = logging.getLogger("lucid.routes.capture_video")

router = APIRouter(prefix="/api/capture", tags=["capture", "video"])


class VideoCaptureRequest(LucidBaseModel):
    """Request body for POST /api/capture/video."""

    url: AnyUrl = Field(description="Video or audio URL (any yt-dlp-supported source)")
    knowledge_space_id: str | None = Field(
        default=None,
        description="Target knowledge space UUID. Defaults to the user's Personal space.",
    )
    language_hint: str | None = Field(
        default=None,
        description="BCP-47 language hint for the STT engine (e.g. 'ko'). None = auto-detect.",
    )


class VideoCaptureResponse(LucidBaseModel):
    """202 response from POST /api/capture/video."""

    job_id: str
    status: str
    status_url: str


@router.post(
    "/video",
    response_model=VideoCaptureResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Capture video/audio via STT",
    description=(
        "Submit a video or audio URL for automatic speech-to-text capture. "
        "Returns immediately with a job_id; poll /api/jobs/{job_id} for progress."
    ),
)
def capture_video(
    req: VideoCaptureRequest,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
) -> VideoCaptureResponse:
    """Accept a video/audio URL, create a SourceJob, schedule STT extraction."""
    session = _new_session()
    try:
        ks_uuid = (
            uuid.UUID(req.knowledge_space_id)
            if req.knowledge_space_id is not None
            else None
        )
        ks = _resolve_knowledge_space(session, user, ks_uuid)

        source_url = str(req.url)
        policy = _resolve_policy(session, user, source_url)

        job = SourceJobORM(
            user_id=user.id,
            knowledge_space_id=ks.id,
            source_url=source_url,
            source_type=SourceType.VIDEO_STT.value,
            captured_from="api",
            raw_payload=None,
            status=SourceStatus.PENDING_EXTRACT.value,
            policy_at_capture=policy,
            client_metadata={"language_hint": req.language_hint} if req.language_hint else {},
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id

        background_tasks.add_task(_enqueue_extract, job_id)

        logger.info(
            "capture_video: created job %s for url=%s user=%s",
            job_id,
            source_url,
            user.id,
        )
        return VideoCaptureResponse(
            job_id=str(job_id),
            status="queued",
            status_url=f"/api/jobs/{job_id}",
        )
    finally:
        session.close()
