"""Anonymized aggregate accuracy-metric recorders (DCR-001).

All three functions take a SQLAlchemy session so the caller can
attach the write to whatever transaction is in flight (typically the
Validate route's own commit). Each function returns the persisted
ORM row id; callers can ignore the return.

Privacy policy:
  - NO claim text in any log row
  - NO source URL
  - NO Object names
  - fact_uid + pair_uid are opaque UUIDs that map back to ES docs
    only inside the user's own knowledge_space
  - user_id has FK cascade so deleting a user wipes their decision
    history too
"""
from __future__ import annotations

import logging
import uuid
from typing import Literal

from sqlalchemy.orm import Session

from api.storage.postgres.orm import (
    ContradictionLog,
    NegationLog,
    PrecisionLog,
)

logger = logging.getLogger("lucid.metrics")


ValidateDecision = Literal["accept", "edit", "reject", "discard"]
NegationScope = Literal["full", "partial"]
ContradictionPatternLiteral = Literal["A", "B", "C"]


def record_validate_decision(
    session: Session,
    *,
    user_id: uuid.UUID,
    fact_uid: str,
    decision: ValidateDecision,
) -> uuid.UUID:
    """M1: log a Validate decision on one AtomicFact.

    Called from `backend/api/routes/validate.py` after the user
    Accepts / Edits / Rejects / Discards a card in the Decide overlay.
    """
    row = PrecisionLog(user_id=user_id, fact_uid=fact_uid, decision=decision)
    session.add(row)
    session.flush()
    return row.id


def record_negation_correction(
    session: Session,
    *,
    user_id: uuid.UUID,
    fact_uid: str,
    ai_negation_flag: bool,
    user_corrected_flag: bool,
    ai_scope: NegationScope | None,
    user_corrected_scope: NegationScope | None,
) -> uuid.UUID:
    """M2: log the user's correction (if any) of the AI negation tag.

    Fires from the Validate "negation warning card" handler. When the
    user keeps the AI's call, the row still records (flag and scope
    equal); M2 aggregates the disagreement rate.
    """
    row = NegationLog(
        user_id=user_id,
        fact_uid=fact_uid,
        ai_negation_flag=ai_negation_flag,
        user_corrected_flag=user_corrected_flag,
        ai_scope=ai_scope,
        user_corrected_scope=user_corrected_scope,
    )
    session.add(row)
    session.flush()
    return row.id


def record_contradiction_confirmation(
    session: Session,
    *,
    user_id: uuid.UUID,
    pair_uid: str,
    pattern: ContradictionPatternLiteral,
    user_confirmed: bool,
) -> uuid.UUID:
    """M3: log whether the user confirmed a detected ContradictionPair.

    `pair_uid` is the ContradictionPair id from
    `backend/api/models/contradiction.py`. `pattern` is the A / B / C
    detector pattern. `user_confirmed=True` means the user kept the
    flag; False means they marked it not-a-contradiction.
    """
    row = ContradictionLog(
        user_id=user_id,
        pair_uid=pair_uid,
        pattern=pattern,
        user_confirmed=user_confirmed,
    )
    session.add(row)
    session.flush()
    return row.id
