"""Beta application intake — landing v8.2 form target.

Public endpoint. No auth required (this is pre-account collection).
Persists to ES `lucid_applications`. Idempotent on email_lower.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status

from api.models.applications import ApplicationRequest, ApplicationResponse
from api.storage.elasticsearch.client import LUCID_APPLICATIONS, get_client

logger = logging.getLogger("lucid.routes.applications")

router = APIRouter(prefix="/api/applications", tags=["applications"])


@router.post("", response_model=ApplicationResponse, status_code=201)
def submit_application(
    req: ApplicationRequest, request: Request
) -> ApplicationResponse:
    """Persist a beta application to `lucid_applications`.

    Idempotent on email_lower (case + whitespace normalised):
    a second submit with the same email returns the EXISTING
    application_id + status='received', NOT a 4xx.
    """
    client = get_client()

    email_lower = req.email.lower().strip()
    try:
        hits = client.search(
            index=LUCID_APPLICATIONS,
            size=1,
            query={"term": {"email_lower": email_lower}},
        )["hits"]["hits"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("applications: dup-check ES failed: %s", exc)
        hits = []

    if hits:
        existing = hits[0]["_source"]
        return ApplicationResponse(
            application_id=existing["application_id"],
            status=existing.get("status", "received"),
            duplicate=True,
        )

    application_id = str(uuid.uuid4())
    ip = request.client.host if request.client else ""
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:16] if ip else ""
    ua = request.headers.get("user-agent", "")[:512]

    doc = {
        "application_id": application_id,
        "email": req.email,
        "email_lower": email_lower,
        "display_name": req.display_name or "",
        "lang": req.lang or "ko",
        "survey_q1_key": req.survey_q1_key,
        "survey_q1_value": req.survey_q1_value,
        "survey_q2_key": req.survey_q2_key,
        "survey_q2_value": req.survey_q2_value,
        "status": "received",
        "submitted_at": datetime.now(UTC).isoformat(),
        "submitter_ip_hash": ip_hash,
        "user_agent": ua,
    }

    try:
        client.index(
            index=LUCID_APPLICATIONS,
            id=application_id,
            document=doc,
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("applications: ES index failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="application_storage_unavailable",
        ) from exc

    return ApplicationResponse(
        application_id=application_id,
        status="received",
        duplicate=False,
    )
