"""Beta application intake — landing v8.2 form payload schema.

CODE-grade addition (B-62 landing-integration). Public, pre-account.
No DB migration — persisted only to ES (`lucid_applications`).
"""
from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class ApplicationRequest(BaseModel):
    email: EmailStr
    display_name: str | None = None
    lang: str | None = Field(default="ko", pattern="^(ko|en)$")
    survey_q1_key: str = Field(..., min_length=1, max_length=128)
    survey_q1_value: str = Field(..., min_length=1, max_length=4096)
    survey_q2_key: str = Field(..., min_length=1, max_length=128)
    survey_q2_value: str = Field(..., min_length=1, max_length=4096)


class ApplicationResponse(BaseModel):
    application_id: str
    status: str
    duplicate: bool = False
