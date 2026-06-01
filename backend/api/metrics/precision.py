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
    StructureMetricsLog,
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


def record_structure_metrics(
    session: Session,
    *,
    user_id: uuid.UUID,
    source_job_id: uuid.UUID,
    fact_count: int,
    object_count_auto: int,
    object_count_new: int,
    object_count_disambig: int,
    link_count: int,
    negates_count: int,
    decomposer_model: str | None = None,
    latency_ms: int | None = None,
) -> uuid.UUID:
    """Sprint 3 PR-3-3 — log structure-stage aggregate per SourceJob.

    Called from `api/structure/processor.process_extracted_job()` right
    before committing `status='structured'`. The row carries ONLY counts +
    the decomposer model id + latency. Claim text, object names, and
    source URLs are NEVER persisted (DCR-001 privacy invariant).
    """
    row = StructureMetricsLog(
        user_id=user_id,
        source_job_id=source_job_id,
        fact_count=fact_count,
        object_count_auto=object_count_auto,
        object_count_new=object_count_new,
        object_count_disambig=object_count_disambig,
        link_count=link_count,
        negates_count=negates_count,
        decomposer_model=decomposer_model,
        latency_ms=latency_ms,
    )
    session.add(row)
    session.flush()
    return row.id
