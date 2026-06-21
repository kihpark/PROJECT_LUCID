"""Pydantic request/response shapes for auth + settings routes (Sprint 1B)."""
from __future__ import annotations

from typing import Literal

from pydantic import EmailStr, Field

from api.models.base import UID, LucidBaseModel


class RegisterRequest(LucidBaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str | None = Field(default=None, max_length=120)


class LoginRequest(LucidBaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(LucidBaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class UserPublic(LucidBaseModel):
    id: UID
    email: EmailStr
    name: str | None = None


class RegisterResponse(LucidBaseModel):
    user: UserPublic
    space_id: UID
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class KnowledgeSpacePublic(LucidBaseModel):
    id: UID
    type: Literal["personal", "team", "policy", "public"]
    name: str | None = None
    user_id: UID


class UpdateSpaceRequest(LucidBaseModel):
    name: str | None = Field(default=None, max_length=160)


class UserSettingsResponse(LucidBaseModel):
    validation_mode: Literal["quick", "strict", "hybrid"]
    surface_on_by_default: bool


class UpdateUserSettingsRequest(LucidBaseModel):
    validation_mode: Literal["quick", "strict", "hybrid"] | None = None
    surface_on_by_default: bool | None = None


class MeResponse(LucidBaseModel):
    """B-61 — identity + cold-start signal for the SPA.

    `display_name` is the User.name column (the schema has no separate
    `display_name`; the FE falls back to the local part of the email
    when null). `default_space_id` is the user's first personal
    KnowledgeSpace (ordered by created_at) — never null in practice
    because /register auto-creates one, but the contract is
    `UID | None` for safety. `is_new_user` is True when the user was
    created within the last 7 days AND the default space holds zero
    non-retracted facts. Used to decide whether the FE shows the
    personalised welcome line above the cold-start 3-step card.
    """

    user_id: UID
    email: EmailStr
    display_name: str | None = None
    default_space_id: UID | None = None
    is_new_user: bool = False
