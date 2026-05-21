"""Pydantic v2 base config + shared types for Lucid models.

LucidBaseModel:
  - extra="forbid"          — typo and stale-field protection (DR-053:
    no valid_until / is_stale / stale_at can ever be set)
  - validate_assignment=True — keeps invariants after construction
  - populate_by_name=True    — allow field aliases (e.g. `class_` <- `class`)

UID:
  - String alias for a UUID4. Stored as `str` because Elasticsearch
    indexes `keyword` natively. UUID4 is generated lazily by helpers
    (`new_uid`) rather than as a default factory on every model — this
    keeps construction explicit at the call site.

utc_now:
  - Helper returning a timezone-aware UTC datetime. Use this for
    every default timestamp.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict

UID = Annotated[str, "uuid4 string"]


def utc_now() -> datetime:
    """Timezone-aware UTC `now()`. Use everywhere instead of naive datetimes."""
    return datetime.now(UTC)


def new_uid() -> UID:
    """Generate a fresh UUID4 as a lowercase hex string."""
    return str(uuid.uuid4())


class LucidBaseModel(BaseModel):
    """Project-wide Pydantic base.

    Every Lucid model inherits from this. The strict `extra="forbid"` setting
    is load-bearing: it blocks `valid_until`, `is_stale`, `stale_at` and
    other retired-in-v2 fields from ever landing on a FactNode or AtomicFact
    (see DR-053 / CONFLICTS.md C-14).
    """

    model_config = ConfigDict(
        extra="forbid",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )
