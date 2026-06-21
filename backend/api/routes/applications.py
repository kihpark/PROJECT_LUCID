"""Beta application intake — landing v8.2 form target.

Public endpoint. No auth required (this is pre-account collection).
Persists to ES `lucid_applications`. Upsert on email_lower —
re-submitting from the same email overwrites the existing doc and
reuses the original application_id.

feat/landing-fix-spec changes vs. landing-integration:
  - Form is now flat: email + profession + q1 + q2 (+ lang).
  - Server fills source="landing-v82", status="pending",
    created_at=now() on every write. (Was: status="received",
    submitted_at=now(), source absent.)
  - Duplicate response field is gone — the existing application_id
    is silently reused (upsert).
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

SOURCE_LANDING_V82 = "landing-v82"
STATUS_PENDING = "pending"


@router.post("", response_model=ApplicationResponse, status_code=201)
def submit_application(
    req: ApplicationRequest, request: Request
) -> ApplicationResponse:
    """Persist a beta application to `lucid_applications`.

    Upsert on email_lower (case + whitespace normalised). A second
    submit with the same email reuses the existing application_id
    and overwrites the doc with the new payload (last-write-wins).
    `created_at` is refreshed on each write so downstream review
    queues see the latest submission timestamp.
    """
    client = get_client()

    email_lower = req.email.lower().strip()
    application_id: str | None = None
    try:
        hits = client.search(
            index=LUCID_APPLICATIONS,
            size=1,
            query={"term": {"email_lower": email_lower}},
        )["hits"]["hits"]
        if hits:
            application_id = hits[0]["_source"].get("application_id")
    except Exception as exc:  # noqa: BLE001
        # ES being down on the dup-check is recoverable — we just
        # generate a fresh application_id and let the index() call
        # below surface the 503 if ES is truly unreachable.
        logger.warning("applications: dup-check ES failed: %s", exc)

    if application_id is None:
        application_id = str(uuid.uuid4())

    ip = request.client.host if request.client else ""
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:16] if ip else ""
    ua = request.headers.get("user-agent", "")[:512]

    doc = {
        "application_id": application_id,
        "email": req.email,
        "email_lower": email_lower,
        "profession": req.profession,
        "q1": req.q1,
        "q2": req.q2,
        "lang": req.lang or "ko",
        "source": SOURCE_LANDING_V82,
        "status": STATUS_PENDING,
        "created_at": datetime.now(UTC).isoformat(),
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
        status=STATUS_PENDING,
    )
