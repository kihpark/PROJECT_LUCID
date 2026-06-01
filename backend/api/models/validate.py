"""Pydantic request/response models for the Validate routes.

Sprint 4B PR-4B-1 — backs the Decide Overlay (Pack 2 C-3 / C-4) and the
Pending Queue (Pack 3 Q-1 / Q-2 / Q-3).

`extra="forbid"` and `validate_assignment=True` are inherited from
`LucidBaseModel`. None of the request models leak source URLs or
object names into telemetry; all anonymization happens at the
`api.metrics.precision.record_validation_decision` call site.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from api.models.base import LucidBaseModel

# ---------------------------------------------------------------------------
# Pending list / detail
# ---------------------------------------------------------------------------

class PendingFilters(LucidBaseModel):
    """Query-string filter shape (FastAPI Depends() expands these)."""

    source_url: str | None = None
    source_type: str | None = None
    captured_after: datetime | None = None
    captured_before: datetime | None = None
    has_negation_flag: bool | None = None
    has_disambiguation: bool | None = None


class PendingJobSummary(LucidBaseModel):
    """One row in the GET /pending list response."""

    job_id: str
    source_url: str
    source_type: str
    captured_at: datetime
    captured_from: str
    fact_count: int
    object_count: int
    has_negation: bool
    has_disambiguation: bool


class PendingJobDetail(LucidBaseModel):
    """GET /pending/{job_id} — full decomposition output."""

    job_id: str
    source_url: str
    source_type: str
    captured_at: datetime
    captured_from: str
    knowledge_space_id: str
    extracted_text_preview: str
    facts: list[dict[str, Any]] = Field(default_factory=list)
    objects: list[dict[str, Any]] = Field(default_factory=list)
    fact_object_links: list[dict[str, Any]] = Field(default_factory=list)
    fact_fact_links: list[dict[str, Any]] = Field(default_factory=list)
    disambiguation_pending: list[dict[str, Any]] = Field(default_factory=list)


class PendingPage(LucidBaseModel):
    """Cursor-less pagination shape."""

    items: list[PendingJobSummary]
    total: int
    offset: int
    limit: int


# ---------------------------------------------------------------------------
# Decide
# ---------------------------------------------------------------------------

FactAction = Literal["accept", "edit", "discard"]
ObjectAction = Literal["create_new", "merge_with", "skip"]


class FactDecision(LucidBaseModel):
    """One per-fact decision inside POST /decide."""

    fact_uid: str
    action: FactAction
    edited_claim: str | None = None
    edited_metadata: dict[str, Any] | None = None


class ObjectDecision(LucidBaseModel):
    """One per-Object disambiguation choice inside POST /decide."""

    candidate_id: str
    action: ObjectAction
    merge_target_uid: str | None = None


class DecideRequest(LucidBaseModel):
    decisions: list[FactDecision] = Field(default_factory=list)
    object_decisions: list[ObjectDecision] = Field(default_factory=list)


class DecideResponse(LucidBaseModel):
    accepted_facts: list[str] = Field(default_factory=list)
    edited_facts: list[str] = Field(default_factory=list)
    discarded_facts: list[str] = Field(default_factory=list)
    created_objects: list[str] = Field(default_factory=list)
    merged_objects: list[str] = Field(default_factory=list)
    skipped_objects: list[str] = Field(default_factory=list)
    validation_log_count: int


# ---------------------------------------------------------------------------
# Disambig
# ---------------------------------------------------------------------------

class DisambigEntry(LucidBaseModel):
    """One row in GET /disambig — a Pending Object decision."""

    disambig_id: str   # synthetic id: f"{job_id}:{llm_uid}"
    job_id: str
    candidate_name: str
    decision_reason: str
    candidates: list[dict[str, Any]] = Field(default_factory=list)


class DisambigResolveRequest(LucidBaseModel):
    action: ObjectAction
    merge_target_uid: str | None = None


# ---------------------------------------------------------------------------
# Graph notes (Review mode)
# ---------------------------------------------------------------------------

class GraphNoteCreateRequest(LucidBaseModel):
    note: str = Field(min_length=1, max_length=8000)


class GraphNoteResponse(LucidBaseModel):
    id: str
    fact_uid: str
    note: str
    created_at: datetime
    updated_at: datetime
