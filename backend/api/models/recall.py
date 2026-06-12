"""Recall response shapes (DR-089 dogfood thin slice).

A single GET endpoint returns a signature line + zero or more validated
facts. The signature is part of the contract — every Lucid response
declares "As far as I know" so the consumer (and the user) knows the
content is grounded in their own verified graph, not LLM completion.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from api.models.base import LucidBaseModel


class RecallFact(LucidBaseModel):
    """One validated fact in a recall response.

    Mirrors `FactNode` with the fields the dogfood UI actually renders.
    Crucially `validation_method` is constrained to `'manual'` here —
    the route enforces this filter before serialising.
    """

    fact_uid: str
    claim: str
    claim_en: str | None = None
    subject_uid: str
    predicate: str
    object_value: str
    source_uids: list[str] = Field(default_factory=list)
    validated_at: datetime
    validator_id: str
    validation_method: Literal["manual"]
    knowledge_space_id: str
    negation_flag: bool = False
    negation_scope: Literal["full", "partial"] | None = None
    score: float


class RecallResponse(LucidBaseModel):
    """The thin-slice recall envelope.

    `signature` is the user-facing identity sentence. Two shapes:
      - hits >= 1: "As far as I know — 그래프에 N개 검증 사실이 있습니다"
      - hits == 0: "검증된 사실이 없습니다" (zero-hallucination contract;
        the route MUST NOT generate, paraphrase, or augment.)

    `total` is the count of returned facts (post-threshold), not the
    pre-threshold ES hit count. The threshold-fail case is
    indistinguishable from the zero-stored-fact case on purpose.
    """

    signature: str
    facts: list[RecallFact] = Field(default_factory=list)
    total: int
