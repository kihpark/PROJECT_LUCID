"""Beta application intake — landing v8.2 form payload schema.

feat/landing-fix-spec: PO-spec final shape. Flat 4-field form:
email + profession + q1 + q2 (+ lang). No DB migration — persisted
only to ES (`lucid_applications`). Server-side fields source / status
/ created_at / submitter_ip_hash / user_agent are added by the route
handler, NOT by the client.
"""
from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class ApplicationRequest(BaseModel):
    email: EmailStr
    profession: str = Field(..., min_length=1, max_length=200)
    q1: str = Field(..., min_length=1, max_length=4096)
    q2: str = Field(..., min_length=1, max_length=4096)
    lang: str | None = Field(default="ko", pattern="^(ko|en)$")


class ApplicationResponse(BaseModel):
    application_id: str
    # Always "pending" right after upsert. feat/B-61-fix-admission will
    # drive transitions to approved / rejected via a separate endpoint.
    status: str
