"""DisambiguationCard + DisambiguationLog (DCR-001).

DisambiguationCard is the in-flight payload the Structurer emits for
the Validate UI (transient — never persisted in this shape).
DisambiguationLog is the Postgres row written when the user decides;
schema lives in alembic 0007_disambiguation_logs.

Threshold policy (DCR-001 / DR-065 reframes DR-032):

    Auto-merge:
      Most classes               score >= 0.95
      Person/Org/Service         score >= 0.98
    Disambiguation queue (user):
      Everything below the auto-merge threshold.
      The retired 0.85-0.95 semi-auto band goes here.
    Keep separate:
      User picks "create new" in the card.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now

DecisionMethod = Literal["existing", "new"]


class DisambiguationCandidate(LucidBaseModel):
    """One row inside a DisambiguationCard."""

    object_uid: UID
    score: float = Field(ge=0.0, le=1.0)
    summary: str | None = None  # e.g. "Apple Inc. (Organization), 2 facts"


class DisambiguationCard(LucidBaseModel):
    """In-flight payload from Structure to the Validate UI.

    `original_mention` is the verbatim Object mention in the source
    text. `context` is a short window around the mention so the user
    can disambiguate without re-reading the whole capture.
    """

    fact_uid: UID
    original_mention: str
    context: str | None = None
    candidates: list[DisambiguationCandidate] = Field(default_factory=list)


class DisambiguationLog(LucidBaseModel):
    """Pydantic mirror of the Postgres `disambiguation_logs` row.

    Mirrored so the Validate API can return / accept the same shape;
    the persisted ORM is `api.storage.postgres.orm.DisambiguationLog`.
    """

    fact_uid: UID
    mention_text: str
    resolved_to_uid: UID | None  # None when decision_method='new'
    decision_method: DecisionMethod
    decided_at: datetime = Field(default_factory=utc_now)
    decided_by: UID
