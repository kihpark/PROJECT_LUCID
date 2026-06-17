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
    # B-25 stage 2 / B-35 wiring: how this fact reached the response.
    #   "embedding"   — kNN against the query embedding
    #   "entity_link" — the kNN matches surfaced an entity uid and this
    #                   fact references the SAME canonical Object uid
    #                   on subject or object_value (the cross-fact /
    #                   cross-job graph join enabled by B-35).
    # Frontend uses this to label expanded facts so the user understands
    # why a fact appears even when its claim text didn't directly match.
    match_kind: Literal["embedding", "entity_link"] = "embedding"


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
    # B-25 stage 2: how many of `facts` came in via the entity-link
    # second pass. 0 when the result set is pure semantic-match.
    expanded_count: int = 0
