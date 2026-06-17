"""Structure-stage Pydantic shapes (Sprint 3 PR-3-1).

The decomposer emits one `StructureResult` per merged_text. The shape
mirrors the DCR-001 output JSON contract in structure-stage-spec.md
Appendix A §A.4:

    {
      "objects": [...],
      "facts": [...],
      "fact_object_links": [...],
      "fact_fact_links": [...],
      "disambiguation_candidates": [...],
      "extraction_status": "success" | "no_facts_found",
      "failure_reason": null | "opinion_content" | ... | "negation_ambiguous" | ...
    }

Object matching, embedding, and ES persistence happen downstream (PR-3-2
+ PR-3-3); this PR only ships the LLM decomposition layer.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import ConfigDict, Field

from api.models.base import UID, LucidBaseModel
from api.models.facts import FactType
from api.models.objects import ObjectClass

ExtractionStatus = Literal["success", "no_facts_found"]
FailureReason = Literal[
    "opinion_content",
    "advertisement",
    "non_factual_creative",
    "ambiguous_attribution",
    "non_verifiable",
    "negation_ambiguous",
    "malformed_llm_output",
    "empty_input",
]


class StructureObject(LucidBaseModel):
    """One Object candidate emitted by the decomposer."""

    uid: UID
    class_: ObjectClass = Field(alias="class")
    name: str
    name_en: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)


class StructureFact(LucidBaseModel):
    """One AtomicFact emitted by the decomposer.

    B-36 defence: `extra='ignore'` overrides the project-wide
    `extra='forbid'` policy specifically for the LLM-intermediate
    layer. The LLM has been observed emitting fields that
    DR-053 retired (`valid_from`) or that were never in the
    schema (`source_quote`, `confidence`, `valid_until`). Silently
    dropping them lets the parse succeed; the persistence layer
    (FactNode in `api.storage.elasticsearch.facts`) still keeps
    `extra='forbid'`, so retired fields never reach the graph.
    """

    model_config = ConfigDict(
        extra="ignore",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    uid: UID
    claim: str
    type_: FactType = Field(alias="type")
    subject_uid: UID
    predicate: str
    object_value: str
    negation_flag: bool = False
    negation_scope: Literal["full", "partial"] | None = None
    tags_suggested: list[str] = Field(default_factory=list)


class StructureFactObjectLink(LucidBaseModel):
    """One Fact -> Object edge (5 link types)."""

    fact_uid: UID
    object_uid: UID
    link_type: Literal[
        "asserts_property", "describes_state", "addresses", "uses", "involves"
    ]
    properties: dict[str, Any] = Field(default_factory=dict)


class StructureFactFactLink(LucidBaseModel):
    """One Fact -> Fact edge (7 link types incl. NEGATES from DCR-001).

    B-36 defence: like StructureFact, accepts and ignores extra
    fields the LLM may emit (e.g. an empty `properties` dict copied
    over from the Fact -> Object link shape). The persistence layer
    keeps the strict shape.
    """

    model_config = ConfigDict(
        extra="ignore",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    from_uid: UID
    to_uid: UID
    link_type: Literal[
        "supports",
        "contradicts",
        "example_of",
        "derived_from",
        "interprets",
        "supersedes",
        "negates",
    ]


class StructureDisambiguation(LucidBaseModel):
    """One disambiguation candidate emitted when an Object mention has
    multiple plausible matches (handled by Validate UI per DCR-001)."""

    fact_uid: UID
    mention_text: str
    candidate_object_uids: list[UID] = Field(default_factory=list)
    scores: list[float] = Field(default_factory=list)


class StructureResult(LucidBaseModel):
    """Top-level decomposer output. Persisted later by PR-3-2 / PR-3-3."""

    objects: list[StructureObject] = Field(default_factory=list)
    facts: list[StructureFact] = Field(default_factory=list)
    fact_object_links: list[StructureFactObjectLink] = Field(default_factory=list)
    fact_fact_links: list[StructureFactFactLink] = Field(default_factory=list)
    disambiguation_candidates: list[StructureDisambiguation] = Field(default_factory=list)
    extraction_status: ExtractionStatus
    failure_reason: FailureReason | None = None
    # Bookkeeping
    input_char_count: int = 0
    input_token_estimate: int = 0
    output_token_estimate: int = 0
    latency_ms: int = 0
    model_used: str = ""


__all__ = [
    "ExtractionStatus",
    "FailureReason",
    "StructureObject",
    "StructureFact",
    "StructureFactObjectLink",
    "StructureFactFactLink",
    "StructureDisambiguation",
    "StructureResult",
]
