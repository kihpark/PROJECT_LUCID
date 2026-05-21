"""ContradictionPair + GatekeepingWarning.

Per docs/surface-stage-spec.md §7 (post v2 update) Contradiction
Detection runs in three patterns:

  Pattern A — auto CONTRADICTS edge: same subject + property + value mismatch
  Pattern B — Suspected: same subject + semantically opposite predicate
  Pattern C — Context-only: same subject but different time / jurisdiction /
              measurement unit. Not a contradiction; surfaced as info.

Gatekeeping (Surface Mode 4) is a separate flow that runs at capture
time and warns the user but never blocks. The `decision` records what
the user chose; "save_anyway" facts also carry override_warning=True
on the resulting FactNode (DR-050).
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now

ContradictionPattern = Literal["A", "B", "C"]


class ContradictionPair(LucidBaseModel):
    """One detected contradiction between two FactNodes."""

    fact_a_uid: UID
    fact_b_uid: UID
    pattern: ContradictionPattern
    detected_at: datetime = Field(default_factory=utc_now)
    resolved: bool = False
    resolution: str | None = None  # "drop_a" | "drop_b" | "keep_both" | "ignore"
    context_note: str | None = None  # required for pattern C (jurisdiction/time)


class GatekeepingWarning(LucidBaseModel):
    """One Gatekeeping warning + the user decision (Save anyway / Cancel).

    Stored separately from FactNode because warnings can fire without a
    FactNode being created (when the user cancels). When the user picks
    `save_anyway`, the resulting FactNode is created with
    override_warning=True (DR-050).
    """

    claim_attempted: str
    source_url: str
    counter_evidence: list[UID] = Field(default_factory=list)
    decision: Literal["cancel", "save_anyway"]
    warned_at: datetime = Field(default_factory=utc_now)
    user_id: UID
