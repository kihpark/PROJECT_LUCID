"""POST /api/auth/{login, logout} + GET /api/auth/me — Sprint 1B / B-61.

Public self-register was removed in B-61-fix-admission. New accounts
are provisioned by an admin via /api/admin/applications/{id}/approve
(see api/routes/admin_applications.py). Login + logout + /me still
live here and serve the same shape they always have.

Logout is a stateless client-side discard in beta. The endpoint
exists so the frontend has a target to call, but the server cannot
revoke a live JWT short of key rotation. Phase 1+ may add a token
denylist if a real revoke flow is needed.

B-61 adds GET /me — identity + cold-start signal for the SPA.
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from api.models.auth import (
    LoginRequest,
    MeResponse,
    TokenResponse,
)
from api.security import (
    create_access_token,
    get_current_user,
    verify_password,
)
from api.storage.elasticsearch.facts import count_active_facts
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _new_session():
    return make_sessionmaker()()


def _expires_in_seconds() -> int:
    raw = os.getenv("JWT_EXPIRES_MINUTES", "43200")
    try:
        return int(raw) * 60
    except ValueError:
        return 43200 * 60


@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest) -> TokenResponse:
    """Verify credentials and issue a JWT.

    Returns 401 on missing user or bad password (no leak of which one).
    """
    session = _new_session()
    try:
        user = session.query(User).filter(User.email == str(req.email)).one_or_none()
        if user is None or not user.password_hash:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid_credentials",
            )
        if not verify_password(req.password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid_credentials",
            )

        # Best-effort: update last_login_at
        from sqlalchemy import func

        user.last_login_at = func.now()  # type: ignore[assignment]
        session.commit()

        token = create_access_token(user.id)
        return TokenResponse(
            access_token=token,
            expires_in=_expires_in_seconds(),
        )
    finally:
        session.close()


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(_user: User = Depends(get_current_user)) -> None:
    """Stateless beta logout. Client discards the token.

    Returns 204. Requires a valid JWT (so callers cannot logout for
    other users), but does not perform any server-side revoke. If
    token denylist is added in Phase 1+, this endpoint records the
    JTI in the denylist.
    """
    logger.info("user %s logged out (stateless)", _user.id)
    return None


@router.get("/me", response_model=MeResponse)
def get_me(user: User = Depends(get_current_user)) -> MeResponse:
    """B-61 — return the caller's identity + cold-start signal.

    - `default_space_id`: the user's first personal KnowledgeSpace
      (ordered by created_at). Always present in practice because
      admin admission auto-creates one; we still return `None` for safety.
    - `is_new_user`: True when the user was created within the last
      7 days AND their default space holds zero non-retracted facts.
      The frontend uses this to gate the personalised welcome line
      above the cold-start 3-step card.

    ES is read best-effort via `count_active_facts`; an ES outage
    degrades to count=0 (treated as cold-start). The endpoint always
    returns 200 for a valid JWT.
    """
    session = _new_session()
    try:
        # Pick the user's first personal space.
        space = (
            session.execute(
                select(KnowledgeSpace)
                .where(
                    KnowledgeSpace.user_id == user.id,
                    KnowledgeSpace.type == "personal",
                )
                .order_by(KnowledgeSpace.created_at.asc())
                .limit(1)
            )
            .scalar_one_or_none()
        )
        default_space_id_str: str | None = (
            str(space.id) if space is not None else None
        )

        # Cold-start signal: created < 7 days ago AND no active facts yet.
        is_new_user = False
        now = datetime.now(UTC)
        user_created_at = user.created_at
        if user_created_at.tzinfo is None:
            user_created_at = user_created_at.replace(tzinfo=UTC)
        within_seven_days = (now - user_created_at) <= timedelta(days=7)
        if within_seven_days:
            if default_space_id_str is None:
                is_new_user = True
            else:
                # ES is best-effort; failures fall through to count=0
                # inside count_active_facts.
                count = count_active_facts(
                    knowledge_space_id=default_space_id_str,
                )
                is_new_user = count == 0

        return MeResponse(
            user_id=str(user.id),
            email=user.email,
            display_name=user.name,
            default_space_id=default_space_id_str,
            is_new_user=is_new_user,
            is_admin=user.is_admin,
        )
    finally:
        session.close()
