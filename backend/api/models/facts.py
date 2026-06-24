"""AtomicFact, FactNode, EditRecord for the Lucid CSVS loop.

AtomicFact is the Structure output (one decomposed claim per AtomicFact).
FactNode is the post-Validate persisted shape stored in the lucid_facts
ES index.

ABSOLUTELY FORBIDDEN on either model (DR-053 / CONFLICTS.md C-14):
  - valid_until        retired with the staleness system
  - is_stale           retired with the staleness system
  - stale_at           retired with the staleness system

`extra="forbid"` on LucidBaseModel rejects unknown fields at construction
time. `tests/unit/test_models_facts.py` has three negative tests that
attempt to set each of the three forbidden fields and assert ValidationError.

`valid_from` is kept as optional **context-only** metadata (DR-053 [변경 2]).
It records when a time-bound claim became true but is never used to
trigger expiry, alerts, or re-validation jobs.
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import ConfigDict, Field

from api.models.base import UID, LucidBaseModel, utc_now


class Locator(LucidBaseModel):
    """Where this fact was extracted from inside the source.

    B-48a Phase 1 leaves the list empty; Phase 2 will fill `char_start`,
    `char_end`, `quote` so the UI can highlight the supporting span,
    and Phase 3 adds image/video locator variants under the same
    discriminator.

    `extra='ignore'` because future variants will introduce fields
    that older readers should silently drop.
    """

    model_config = ConfigDict(
        extra="ignore", validate_assignment=True, populate_by_name=True,
        str_strip_whitespace=True,
    )

    kind: Literal["text", "image", "video"] = "text"
    source_uid: UID
    char_start: int | None = None
    char_end: int | None = None
    quote: str | None = None


class FactType(StrEnum):
    """Decomposition output type produced by the Structure stage."""

    PROPOSITION = "proposition"
    PROCEDURE = "procedure"


class EditRecord(LucidBaseModel):
    """One row of FactNode.edit_history.

    Captures the prior claim text alongside the timestamp so the search
    layer can still match users querying with the pre-edit phrasing.
    Stored inline on the FactNode document (also surfaced via the
    `aliases` flat list for ES text matching).
    """

    from_claim: str
    to_claim: str
    edited_at: datetime = Field(default_factory=utc_now)
    edited_by: UID


class AtomicFact(LucidBaseModel):
    """Decomposed claim emitted by the Structurer (Sprint 3).

    The Capture/Structure pipeline produces zero or more AtomicFact
    instances per merged_text. Each AtomicFact carries no validation
    state; validation lifts it to a FactNode (PR-1A-3 storage layer,
    Sprint 4 Validate UI).

    PO directive 2026-05-21 [변경 2]:
      - NO `valid_until` field (forbidden by extra="forbid")
      - NO `is_stale` field (forbidden by extra="forbid")
      - NO `stale_at` field (forbidden by extra="forbid")
      - `valid_from` stays as context-only metadata; never triggers expiry.

    DCR-001 (2026-05-28):
      - `negation_flag` marks intrinsically-negative claims
      - `negation_scope` ('full' | 'partial' | None) clarifies the
        negation extent. When ambiguous, the structurer emits with
        failure_reason='negation_ambiguous' and routes the fact to
        the Validate disambiguation queue.
    """

    claim: str
    type_: FactType = Field(alias="type")
    subject_uid: UID
    predicate: str
    object_value: str
    valid_from: datetime | None = None
    tags_suggested: list[str] = Field(default_factory=list)
    negation_flag: bool = False
    negation_scope: Literal["full", "partial"] | None = None


class FactNode(LucidBaseModel):
    """Validated and persisted fact. Lives in the lucid_facts ES index.

    Same forbidden-fields rule as AtomicFact. `validated_at`,
    `validation_method`, and `validator_id` are required because every
    FactNode is, by definition, validated. `aliases` is the flat list
    of prior claims used for search robustness (Edit history; see
    docs/validate-stage-spec.md §14 Q1).
    """

    fact_uid: UID
    claim: str
    claim_en: str | None = None
    type_: FactType = Field(alias="type")
    subject_uid: UID
    predicate: str
    object_value: str
    valid_from: datetime | None = None
    validated_at: datetime = Field(default_factory=utc_now)
    validation_method: Literal["manual", "auto"]
    validator_id: UID
    source_uids: list[UID] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    override_warning: bool = False
    edit_history: list[EditRecord] = Field(default_factory=list)
    knowledge_space_id: UID
    negation_flag: bool = False
    negation_scope: Literal["full", "partial"] | None = None
    # B-48a soft-delete scaffold (UI in B-48b). retracted_at set means
    # recall hides this fact by default; retracted_by is the actor uid.
    retracted_at: datetime | None = None
    retracted_by: UID | None = None
    # B-48a locator scaffold. Empty in Phase 1; Phase 2 fills.
    locators: list[Locator] = Field(default_factory=list)
    # B-62 structure-resolve - canonical S-P-O additions. All optional
    # so legacy facts captured before the OPL layer landed still
    # validate. Surface fields (predicate, object_value) stay around
    # for the recall display path.
    predicate_code: str | None = None
    original_surface: str | None = None
    capture_lang: str | None = None
    object_canonical: str | None = None
    canonical_key: str | None = None
    needs_review: bool = False
    # B-62 natural-spo-display: natural-English predicate gloss
    # preserved verbatim for the recall display. NEVER participates in
    # canonical_key (dedup key stays subject_uid / predicate_code /
    # object_canonical). Display layer only.
    predicate_label: str | None = None
    # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split.
    # `fact_type` is the NEW 3-way bucket ('action' | 'claim' |
    # 'measurement') that drives the recall facet and the FactCard
    # rendering branch. The legacy `type_` enum (`proposition` /
    # `procedure`) stays untouched — it is a DIFFERENT axis kept for
    # back-compat with the old structurer payload. The two coexist as
    # separate ES fields: `type` (legacy enum, FactNode.type_) and
    # `fact_type` (new string, FactNode.fact_type).
    #
    # All five claim-only fields are populated by the LLM at structure
    # time only when fact_type=='claim'; legacy / action / measurement
    # docs leave them None and the recall facet bucket / FactCard
    # branches gate on `fact_type=='claim'` before reading them.
    # `speech_act` is intentionally open natural-language (no enum) so
    # the loose ontology survives unknown verbs.
    fact_type: str | None = None
    speaker_uid: str | None = None
    speaker_label: str | None = None
    speech_act: str | None = None
    content_claim: str | None = None
    stance: str | None = None
    # v0.2.0 step 2 (fact-measurement-layer-v1): measurement layer.
    # Populated only when fact_type=='measurement'. `metric` is OPEN
    # Korean / source-language string (no controlled vocabulary at
    # extraction time). `measurement_value` is a float — the PO use
    # cases (MAU ~ 1e9, %, 조 원) all fit safely in IEEE-754, and ES
    # `double` carries it. `as_of` is OPEN string — "2026", "2026-03",
    # "2026-Q1", "2026-03-23" all valid; the LLM emits whatever
    # granularity the source supports.
    metric: str | None = None
    measurement_value: float | None = None
    measurement_unit: str | None = None
    as_of: str | None = None
