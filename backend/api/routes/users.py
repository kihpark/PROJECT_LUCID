"""User-scoped routes — /api/users/me + /api/users/me/settings (Sprint 1B).

Settings persisted in the Postgres `user_settings` table (one row per
user, FK cascade on user delete). The row is created during registration
with defaults (validation_mode='quick', surface_on_by_default=True).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from api.models.auth import (
    UpdateUserSettingsRequest,
    UserPublic,
    UserSettingsResponse,
)
from api.security import get_current_user
from api.storage.postgres.orm import User, UserSettings
from api.storage.postgres.session import make_sessionmaker

router = APIRouter(prefix="/api/users", tags=["users"])


def _new_session():
    return make_sessionmaker()()


@router.get("/me", response_model=UserPublic)
def get_me(user: User = Depends(get_current_user)) -> UserPublic:
    return UserPublic(id=str(user.id), email=user.email, name=user.name)


@router.get("/me/settings", response_model=UserSettingsResponse)
def get_my_settings(user: User = Depends(get_current_user)) -> UserSettingsResponse:
    session = _new_session()
    try:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user.id)
            .one_or_none()
        )
        if row is None:
            # Should not happen for users created via /register, but make
            # the route self-healing for legacy users.
            row = UserSettings(
                user_id=user.id,
                validation_mode="quick",
                surface_on_by_default=True,
            )
            session.add(row)
            session.commit()
            session.refresh(row)
        return UserSettingsResponse(
            validation_mode=row.validation_mode,
            surface_on_by_default=row.surface_on_by_default,
        )
    finally:
        session.close()


@router.patch("/me/settings", response_model=UserSettingsResponse)
def update_my_settings(
    req: UpdateUserSettingsRequest,
    user: User = Depends(get_current_user),
) -> UserSettingsResponse:
    session = _new_session()
    try:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user.id)
            .one_or_none()
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="settings_not_found",
            )
        if req.validation_mode is not None:
            row.validation_mode = req.validation_mode
        if req.surface_on_by_default is not None:
            row.surface_on_by_default = req.surface_on_by_default
        session.commit()
        session.refresh(row)
        return UserSettingsResponse(
            validation_mode=row.validation_mode,
            surface_on_by_default=row.surface_on_by_default,
        )
    finally:
        session.close()
