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
    """One Object candidate emitted by the decomposer.

    Faithful-decomp PR (PO 2026-06-23): `extra='ignore'` so the LLM
    can pad fields (`entity_type`, `person_origin`, `confidence`, …)
    without failing the entire envelope. Storage-layer Object models
    keep their own `extra='forbid'`, so retired fields still never
    reach ES.
    """

    model_config = ConfigDict(
        extra="ignore",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    uid: UID
    class_: ObjectClass = Field(alias="class")
    name: str
    name_en: str | None = None
    # B-52: surface-form aliases (Korean original / abbreviations /
    # English calque) so a query in the source language matches an
    # entity normalized into another language.
    aliases: list[str] = Field(default_factory=list)
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
    # B-62-fix-v2 (PO 2026-06-22): the LLM's verbatim source-text span
    # for the subject (and the object when it is an entity). Used by
    # the entity resolver so canonical primary_label preserves the
    # source-language form. Optional for backward compatibility — the
    # decomposer / processor falls back to the StructureObject's `name`
    # when the LLM omits the field.
    subject_surface: str | None = None
    object_surface: str | None = None
    predicate: str
    object_value: str
    negation_flag: bool = False
    negation_scope: Literal["full", "partial"] | None = None
    tags_suggested: list[str] = Field(default_factory=list)
    # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split.
    # PO directive 2026-06-23 — the LLM tags each fact's `fact_type`
    # so downstream surfaces can distinguish a current-event
    # ("X did Y") from a one-hop provenance utterance ("X said Y").
    # Default 'action' on legacy / silent payloads — back-compat.
    # `speech_act` is intentionally open natural-language (no enum)
    # so the loose ontology survives unknown verbs.
    fact_type: Literal["action", "claim"] = "action"
    speaker_uid: str | None = None
    speaker_label: str | None = None
    speech_act: str | None = None
    content_claim: str | None = None
    stance: str | None = None


class StructureFactObjectLink(LucidBaseModel):
    """One Fact -> Object edge (5 link types).

    Faithful-decomp PR: `extra='ignore'` so LLM padding (e.g. `confidence`,
    `metadata`) doesn't tank the envelope.
    """

    model_config = ConfigDict(
        extra="ignore",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

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
    multiple plausible matches (handled by Validate UI per DCR-001).

    Faithful-decomp PR: `extra='ignore'` for LLM padding tolerance.
    """

    model_config = ConfigDict(
        extra="ignore",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    fact_uid: UID
    mention_text: str
    candidate_object_uids: list[UID] = Field(default_factory=list)
    scores: list[float] = Field(default_factory=list)


class StructureResult(LucidBaseModel):
    """Top-level decomposer output. Persisted later by PR-3-2 / PR-3-3.

    Faithful-decomp PR (PO 2026-06-23): `extra='ignore'` so the LLM
    can pad top-level keys (e.g. `version`, `comment`, `meta`) without
    failing the entire envelope. The 6-round cumulative-constraint
    prompt was producing extra keys whose Pydantic rejection turned
    a 5-fact response into facts=0; we now silently drop them.
    """

    model_config = ConfigDict(
        extra="ignore",
        validate_assignment=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

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
