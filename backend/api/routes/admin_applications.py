"""Admin admission endpoints — B-61-fix-admission.

Reads pending entries from the ES index `lucid_applications` (owned by
the landing-form intake at /api/applications) and lets an admin approve
them, which creates a User + Personal KnowledgeSpace + UserSettings in
one Postgres transaction and returns a one-time temp password.

All endpoints gated by `require_admin` — non-admin callers get 403.
The endpoints depend ONLY on `application_id`, `email`, and `status`
from each ES doc so future landing-form schema changes don't break
the admission path.
"""
from __future__ import annotations

import logging
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from api.security import hash_password, require_admin
from api.storage.elasticsearch.client import LUCID_APPLICATIONS, get_client
from api.storage.postgres.orm import KnowledgeSpace, User, UserSettings
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.admin_applications")

router = APIRouter(
    prefix="/api/admin/applications",
    tags=["admin", "applications"],
)


# Module-level session factory hook — tests rebind this to a test
# sessionmaker (same pattern as auth_route._new_session).
def _new_session():
    return make_sessionmaker()()


class ApplicationListItem(BaseModel):
    application_id: str
    email: str
    profession: str | None = None
    q1: str | None = None
    q2: str | None = None
    lang: str | None = None
    status: str
    created_at: str | None = None


class ApplicationsListResponse(BaseModel):
    items: list[ApplicationListItem]
    total: int


class ApproveResponse(BaseModel):
    application_id: str
    user_id: str
    email: str
    temp_password: str       # one-time, shown ONCE
    already_existed: bool    # True if the User row was already there
    status: str              # "approved" on success / "approved"|"rejected" if re-hit


def _generate_temp_password() -> str:
    """16-char URL-safe one-time password. Long enough that the admin
    can hand it over by chat / email and have the user paste it once."""
    return secrets.token_urlsafe(12)


@router.get("", response_model=ApplicationsListResponse)
def list_applications(
    _admin: User = Depends(require_admin),
    status_filter: str = Query(
        "pending",
        alias="status",
        pattern="^(pending|approved|rejected|all)$",
    ),
    limit: int = Query(100, ge=1, le=500),
) -> ApplicationsListResponse:
    client = get_client()
    query: dict[str, Any] = (
        {"match_all": {}}
        if status_filter == "all"
        else {"term": {"status": status_filter}}
    )
    try:
        res = client.search(
            index=LUCID_APPLICATIONS,
            size=limit,
            query=query,
            sort=[{"created_at": {"order": "asc"}}],
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("admin_applications: ES search failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="applications_storage_unavailable",
        ) from exc

    hits = res["hits"]["hits"]
    items = [
        ApplicationListItem(
            application_id=h["_source"].get("application_id", h["_id"]),
            email=h["_source"].get("email", ""),
            profession=h["_source"].get("profession"),
            q1=h["_source"].get("q1"),
            q2=h["_source"].get("q2"),
            lang=h["_source"].get("lang"),
            status=h["_source"].get("status", "pending"),
            created_at=h["_source"].get("created_at"),
        )
        for h in hits
    ]
    total_obj = res["hits"]["total"]
    total = total_obj["value"] if isinstance(total_obj, dict) else int(total_obj)
    return ApplicationsListResponse(items=items, total=total)


@router.post("/{application_id}/approve", response_model=ApproveResponse)
def approve_application(
    application_id: str,
    _admin: User = Depends(require_admin),
) -> ApproveResponse:
    client = get_client()
    try:
        doc = client.get(index=LUCID_APPLICATIONS, id=application_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, "application_not_found") from exc

    source = doc["_source"]
    email = (source.get("email") or "").strip()
    current_status = source.get("status", "pending")

    if not email:
        raise HTTPException(422, "application_has_no_email")

    session = _new_session()
    try:
        # If the status isn't pending, report current state without
        # creating a new user or issuing a new password.
        if current_status != "pending":
            existing = (
                session.query(User).filter(User.email == email).one_or_none()
            )
            return ApproveResponse(
                application_id=application_id,
                user_id=str(existing.id) if existing is not None else "",
                email=email,
                temp_password="",
                already_existed=True,
                status=current_status,
            )

        # Status is pending — check whether a User already exists.
        existing = (
            session.query(User).filter(User.email == email).one_or_none()
        )
        if existing is not None:
            # Mark the application approved but don't issue a new
            # password (would invalidate the user's current one).
            client.update(
                index=LUCID_APPLICATIONS,
                id=application_id,
                doc={"status": "approved"},
                refresh="wait_for",
            )
            return ApproveResponse(
                application_id=application_id,
                user_id=str(existing.id),
                email=email,
                temp_password="",
                already_existed=True,
                status="approved",
            )

        # New account — create User + KS + UserSettings in one txn.
        temp_password = _generate_temp_password()
        new_user = User(
            email=email,
            password_hash=hash_password(temp_password),
        )
        session.add(new_user)
        session.flush()

        space = KnowledgeSpace(
            user_id=new_user.id,
            type="personal",
            name="Personal",
        )
        session.add(space)

        settings = UserSettings(
            user_id=new_user.id,
            validation_mode="quick",
            surface_on_by_default=True,
        )
        session.add(settings)

        session.commit()
        session.refresh(new_user)

        # Mark the application approved.
        client.update(
            index=LUCID_APPLICATIONS,
            id=application_id,
            doc={"status": "approved"},
            refresh="wait_for",
        )

        return ApproveResponse(
            application_id=application_id,
            user_id=str(new_user.id),
            email=email,
            temp_password=temp_password,
            already_existed=False,
            status="approved",
        )
    finally:
        session.close()
