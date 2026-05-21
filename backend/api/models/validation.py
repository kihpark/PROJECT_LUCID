"""ValidationRecord — one row per validation event on a fact.

PO directive 2026-05-21 [변경 3] introduces the Save / Decide overlay
(Accept all / Review / Discard). The Validate stage emits one
ValidationRecord per FactNode that is created.

`validation_method`:
  - "manual"  the user clicked Accept all / Review-then-Accept
  - "auto"    the source was Trusted (SET-2) and the fact entered the
              graph without HITL.

`notes` carries the optional personal note from Review mode (V-2). At
Save time only tags are captured (PO directive); notes are only added
in Review mode.
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now


class ValidationMethod(StrEnum):
    """Source of the validation decision."""

    MANUAL = "manual"
    AUTO = "auto"


class ValidationRecord(LucidBaseModel):
    """One validation event on a FactNode.

    Multiple records may exist per FactNode if it is re-validated
    after a Gatekeeping override or a Demote-then-Accept cycle.
    """

    fact_uid: UID
    validator_id: UID
    validation_method: ValidationMethod
    validated_at: datetime = Field(default_factory=utc_now)
    override_warning: bool = False
    notes: str | None = None
