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
    match_kind: Literal["embedding", "entity_link"] = "embedding"
    # B-40 defect 1: server-resolved entity labels. The route looks each
    # subject_uid / entity-shape object_value up in lucid_objects and
    # serialises the human-readable name here so RecallView doesn't
    # have to do a second round-trip. None when the entity is unknown
    # (or when object_value is a literal — the frontend then falls
    # back to the raw object_value, which is the literal).
    subject_label: str | None = None
    object_label: str | None = None
    # fix/m32b-entity-type-degree-actual-wiring (PO 2026-06-28): server-
    # resolved entity_type for the subject / entity-shape object. Drives
    # the M3-2b STELLAR visual-vocabulary palette in the FE renderer
    # (ENTITY_COLORS: person/organization/group => WHO teal,
    # product/resource/concept/knowledge => WHAT amber, event => violet,
    # place => WHERE slate). Resolved from lucid_objects.class via a
    # batch mget enrichment pass — same round-trip as the label lookup
    # so the cost stays at O(1) ES calls per recall response.
    # None when:
    #   - the uid is not found in lucid_objects
    #   - object_value is a literal (number / date / Korean string)
    #   - the doc is legacy and has no `class` field
    # The FE colorForEntityType helper falls back to STELLAR_ACCENT for
    # any null/unknown entity_type so missing values never break the
    # render.
    subject_entity_type: str | None = None
    object_entity_type: str | None = None
    # B-62 natural-spo-display: natural-English predicate gloss for
    # the recall card. None on legacy facts captured before the OPL
    # layer landed; the frontend falls back to the canonical predicate
    # surface in that case.
    predicate_label: str | None = None
    # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split.
    # Null on legacy facts captured before the split landed (the
    # recall route defaults the bucket to 'action' when filtering).
    # The FactCard branches on fact_type=='claim' to show the
    # speaker/speech_act strip; otherwise it renders as an action.
    #
    # v0.2.0 step 2 (fact-measurement-layer-v1): 3-way split adds
    # 'measurement' — numeric value tied to a point in time. FactCard
    # branches on fact_type=='measurement' to show the metric / value /
    # unit / as_of strip.
    fact_type: Literal["action", "claim", "measurement"] | None = None
    speaker_label: str | None = None
    speech_act: str | None = None
    content_claim: str | None = None
    stance: str | None = None
    # Measurement-only fields. All None on action / claim / legacy
    # facts; the FactCard branches on fact_type=='measurement' before
    # reading them, so missing values never render.
    metric: str | None = None
    measurement_value: float | None = None
    measurement_unit: str | None = None
    as_of: str | None = None
    # v0.2.0 step 3 (fact-contradiction-detection-v1): count of CONTRADICTS
    # edges in fact_relations where THIS fact is on either side. 0 on
    # facts with no detected contradiction. The RecallFactCard shows an
    # amber [⚠ 모순 N건] badge when > 0. Resolution (merge / pick winner)
    # is deferred — the badge is observational only.
    contradiction_count: int = 0


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
    # B-41 P1: when the query resolves to a known entity, the route
    # builds a brief that re-groups the entity's verified facts by
    # predicate, splitting subject-role from object-role. Pure
    # re-arrangement of validated facts — NO generation, NO inference.
    entity_brief: EntityBrief | None = None
    # B-49: aggregations for the right-rail facet panel.
    facets: RecallFacets = Field(default_factory=lambda: RecallFacets())


class EntityFactRef(LucidBaseModel):
    """A single verified-fact reference inside an EntityBrief group.

    The full RecallFact body lives elsewhere on the response (in
    `facts`); this struct just carries the join key (fact_uid) and
    the rendered triple so the brief can be drawn standalone."""

    fact_uid: str
    claim: str
    predicate: str
    other_uid: str
    other_label: str | None = None


class EntityBriefGroup(LucidBaseModel):
    """All verified facts that share a predicate, on the entity-as-side."""

    predicate: str
    facts: list[EntityFactRef] = Field(default_factory=list)


class EntityBrief(LucidBaseModel):
    """Aggregated, role-split view of an entity's verified facts.

    PO directive (DR-085 aha-C surface = entity synthesis): when the
    user types an entity name, recall should not just list facts; it
    should present a brief that groups them by predicate and splits
    "entity is the subject" from "entity is the object". Generation
    is forbidden — this struct is built entirely from manual facts
    already in `lucid_facts`.
    """

    entity_uid: str
    entity_name: str
    entity_class: str | None = None
    total_facts: int
    # Two role buckets — the entity is the subject on these...
    as_subject: list[EntityBriefGroup] = Field(default_factory=list)
    # ...and the object on these.
    as_object: list[EntityBriefGroup] = Field(default_factory=list)


class EntityFacetItem(LucidBaseModel):
    """One drillable entity bar inside a class bucket on RecallFacets."""

    uid: str
    name: str
    count: int


class EntityFacets(LucidBaseModel):
    """Class-bucketed entity facets. Four canonical buckets in beta."""

    organization: list[EntityFacetItem] = Field(default_factory=list)
    person: list[EntityFacetItem] = Field(default_factory=list)
    place: list[EntityFacetItem] = Field(default_factory=list)
    other: list[EntityFacetItem] = Field(default_factory=list)


class PredicateFacetItem(LucidBaseModel):
    name: str
    count: int


class FactTypeFacets(LucidBaseModel):
    """v0.2.0 step 1/2 — Action / Claim / Measurement split counts.

    Aggregated from the `fact_type` keyword field on lucid_facts.
    Recomputed on every recall call alongside entity / predicate
    facets. Legacy / null fact_type docs do NOT bucket here (the
    terms agg skips missing values); the FE treats them as 'action'
    via the FactCard fallback.

    Step 2 (fact-measurement-layer-v1) adds the `measurement` bucket.
    Legacy clients that didn't expect it still parse cleanly because
    it's a plain int with a 0 default.
    """

    action: int = 0
    claim: int = 0
    measurement: int = 0


class RecallFacets(LucidBaseModel):
    """Aggregations over the CURRENT filtered result set.

    Recomputed on every recall call so the drill-down (entities[])
    narrows the facet view at the same time as the central result
    list. No bucket is sticky.
    """

    entities: EntityFacets = Field(default_factory=lambda: EntityFacets())
    predicates: list[PredicateFacetItem] = Field(default_factory=list)
    # v0.2.0 step 1 — Action vs Claim split counts (additive; the
    # frontend right-rail picks this up to drive the "화자 인용" chip).
    fact_types: FactTypeFacets = Field(default_factory=lambda: FactTypeFacets())


# ---------------------------------------------------------------------------
# fix/r1-recall-redesign — AI 브리핑 (개관) response.
#
# Distinct from ORACLE (/api/assistant/brief — question-answer over the
# verified graph). This endpoint produces an entity 개관 (overview) text
# summarising the CURRENT recall result set: "what does the user already
# know about this entity?". Same zero-hallucination contract: the LLM is
# given ONLY the verified facts the recall returned, and the response
# carries the list of fact_uids the briefing actually leaned on so the
# UI can show grounding (P1·P2).
#
# Cost guard: on-demand button on the FE (the user must click "브리핑
# 보기"), NOT auto-fire on every recall. The endpoint also caches the
# (space_id, query, entity_uids, fact_uid set) → response for 30 minutes
# so a repeat click within the window is free.
# ---------------------------------------------------------------------------


class RecallBriefingResponse(LucidBaseModel):
    """The /recall/briefing envelope.

    `briefing` is the 1-3 sentence overview text. Empty when the recall
    set has no verified facts (the FE renders a zero-fact message
    instead of calling the LLM). `grounded` is true iff `fact_uids` is
    non-empty AND the LLM declared its answer grounded. `fact_uids` is
    the subset of the recall set the LLM cited — these are the only
    facts a downstream UI may render as the briefing's evidence.

    `cached` signals the cache path so smoke tests can assert that a
    second call with the same args is free.
    """

    briefing: str = ""
    fact_uids: list[str] = Field(default_factory=list)
    grounded: bool = False
    cached: bool = False
    # Total verified facts the briefing was computed over. 0 short-
    # circuits the LLM call.
    fact_count: int = 0


# ---------------------------------------------------------------------------
# B-48b — fact detail
# ---------------------------------------------------------------------------

class FactDetailHeader(LucidBaseModel):
    """The fact's own row, rendered with labels already resolved.

    fact-display-unification — fact_type / claim-layer / measurement-
    layer fields are mirrored here so the Recall detail modal can render
    the same [CLAIM]/[MEASUREMENT] badge + speaker/speech_act/content
    strip (or metric/value/unit/as_of strip) that Decide and the Recall
    list already do. Without this, the modal would silently render a
    measurement fact as a plain SPO arrow row — the (d) divergence PO
    escalated. All fields are Optional with None defaults so legacy
    docs that pre-date the layer fields don't crash the response.
    """

    fact_uid: str
    claim: str
    claim_en: str | None = None
    subject_uid: str
    subject_label: str | None = None
    predicate: str
    # fix/recall-predicate-and-entity-type (PO 2026-06-26): mirror the
    # natural-English predicate gloss that RecallFact already carries so
    # the Recall detail modal renders the SAME predicate string that the
    # card does. Without this, the modal called `predicateLabel(predicate)`
    # alone — losing the server-resolved label — and the user saw
    # different predicates on the card vs the detail. Null on legacy
    # docs; the frontend helper falls back to the canonical surface.
    predicate_label: str | None = None
    object_value: str
    object_label: str | None = None
    validated_at: datetime
    retracted_at: datetime | None = None
    retracted_by: str | None = None
    edit_history: list[dict] = Field(default_factory=list)
    # fact-display-unification: layer fields. Mirrors RecallFact above.
    fact_type: str | None = None
    speaker_label: str | None = None
    speech_act: str | None = None
    content_claim: str | None = None
    metric: str | None = None
    measurement_value: float | None = None
    measurement_unit: str | None = None
    as_of: str | None = None


class FactDetailEntity(LucidBaseModel):
    """One Object referenced by the fact (subject or object)."""

    uid: str
    name: str
    name_en: str | None = None
    class_: str | None = Field(default=None, alias="class")
    role: Literal["subject", "object"]
    aliases: list[str] = Field(default_factory=list)


class FactDetailSource(LucidBaseModel):
    """One source row on the detail panel — the data the user reads
    when deciding whether to keep the fact or detach the source."""

    source_uid: str
    source_job_id: str | None = None
    url: str
    domain: str | None = None
    captured_at: datetime | None = None
    source_type: str | None = None
    author: str | None = None
    title: str | None = None
    snapshot_available: bool = False


class FactDetailResponse(LucidBaseModel):
    """GET /api/spaces/{space_id}/facts/{fact_uid} envelope."""

    fact: FactDetailHeader
    entities: list[FactDetailEntity] = Field(default_factory=list)
    sources: list[FactDetailSource] = Field(default_factory=list)


class DetachSourceRequest(LucidBaseModel):
    """POST .../detach-source body."""

    source_uid: str


class ModifyFactRequest(LucidBaseModel):
    """PATCH /api/spaces/{ks}/facts/{fact_uid} body.

    feat/fact-detail-modify (PO directive 2026-06-22): the Recall Fact
    detail modal needs an inline edit affordance — same shape as Decide
    UI's "edit" action, but limited to SURFACE fields. Identity fields
    (subject_uid, fact_type, predicate, validation_method, validator_id)
    stay immutable: structural changes require a retract + re-validate
    flow (out of scope here). predicate_code is legacy after
    feat/stage3-predicate-code-fact-type (2026-06-28) and no longer
    participates in fact identity.

    Every field is optional — only the keys present in the request body
    get touched. Empty body → 400 (no-op patch is a client bug, not an
    accepted state).

    Behaviour:
      - `claim`: if non-empty and different from current, append the old
        claim to aliases + edit_history (existing `update_fact` helper).
        Embedding is re-computed for the new claim text.
      - `predicate_label`: natural-English gloss; updated in place.
      - `object_value`: surface object text; updated in place. Caller
        cannot change this from a literal to an entity uid (that would
        require Decide's entity-resolver path).
      - `tags`: list replaces (not merges) — matches Decide semantics.
    """

    claim: str | None = None
    predicate_label: str | None = None
    object_value: str | None = None
    tags: list[str] | None = None


class FactMutationResponse(LucidBaseModel):
    """Response shared by retract / restore / detach-source — the
    client uses the returned fact_uid to redraw / close the panel
    and the `retracted_at` to flip the visual state."""

    fact_uid: str
    retracted_at: datetime | None = None
    source_uids: list[str] = Field(default_factory=list)
    auto_retracted: bool = False


# ---------------------------------------------------------------------------
# B-62 — facts listing for Stellar real-mode (and any future caller that
# needs "every validated fact in this KS" without a kNN query).
# ---------------------------------------------------------------------------

class FactsList(LucidBaseModel):
    """Bounded list of validated facts in one KS.

    Returned by `GET /api/spaces/{space_id}/facts`. The endpoint is a
    plain ES search (`match_all` + filter on KS + manual), NOT a kNN /
    semantic query — so the user gets ALL their facts, not just the
    ones a query happens to match.

    `total` is the count of returned facts AFTER the `limit` truncation;
    `truncated` flags whether the KS holds more than `limit` (in which
    case the caller should narrow or paginate). The visualisation
    layers don't currently paginate — they take the first batch and
    show a hint when the dataset exceeds it.
    """

    facts: list[RecallFact] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False


# ---------------------------------------------------------------------------
# feat/ledger-view — LEDGER (제3의 뷰).
#
# The third view alongside DECIDE (검증 큐, pre-validation) and RECALL
# (search): a chronological list of recently validated facts. The
# destination for HEARTH "기록 보기" and the weekly briefing's "이번주
# 검증" link.
#
# LedgerItem is a deliberate trim of RecallFact: the score / match_kind /
# contradiction_count / validator_id / validation_method / negation_*  /
# stance fields are dropped because the ledger surface does not need
# them (no relevance ranking, no embedding metadata, no decide-side
# guards). Only the type-layer fields the FactCard renders are kept so
# the CLAIM / MEASUREMENT badge + strip works identically.
# ---------------------------------------------------------------------------

class LedgerItem(LucidBaseModel):
    """One row in the LEDGER view — a validated fact projected to the
    surface fields the chronological list actually renders.

    Identity + chrome (fact_uid, claim, subject/predicate/object,
    source_uids, validated_at, knowledge_space_id) + the type-layer
    fields (fact_type, speaker/speech_act/content_claim,
    metric/value/unit/as_of) + server-resolved labels. No score,
    no match_kind, no contradiction count — the ledger is not a
    relevance surface.
    """

    fact_uid: str
    claim: str
    claim_en: str | None = None
    subject_uid: str
    subject_label: str | None = None
    predicate: str
    predicate_label: str | None = None
    object_value: str
    object_label: str | None = None
    source_uids: list[str] = Field(default_factory=list)
    validated_at: datetime
    knowledge_space_id: str
    # Type-layer fields — same shape FactCard / FactTypeBadge consume.
    fact_type: Literal["action", "claim", "measurement"] | None = None
    speaker_label: str | None = None
    speech_act: str | None = None
    content_claim: str | None = None
    metric: str | None = None
    measurement_value: float | None = None
    measurement_unit: str | None = None
    as_of: str | None = None


class LedgerResponse(LucidBaseModel):
    """GET /api/spaces/{space_id}/ledger envelope.

    `facts` is the time-desc-sorted page (validated_at desc, _id
    secondary for stability). `total` is the count returned by
    ES `hits.total.value` — the FULL match count, not the page —
    so the FE can decide whether to show "더 보기".
    `limit` / `offset` echo the request so the FE's pagination
    state stays in sync with the server.
    """

    facts: list[LedgerItem] = Field(default_factory=list)
    total: int = 0
    limit: int = 20
    offset: int = 0


# ---------------------------------------------------------------------------
# B-55 — Home brief
# ---------------------------------------------------------------------------

class HomeBriefTotals(LucidBaseModel):
    """Aggregate counters for the user's default (or selected) KS.

    All four are scoped to (knowledge_space_id, validation_method=manual)
    where applicable. `this_week_validated` is the count of manual facts
    whose validated_at lands in the last 7 days (UTC, inclusive of now).
    """

    facts: int
    entities: int
    sources: int
    this_week_validated: int


class HomeBriefRecentItem(LucidBaseModel):
    """One row in the "recently validated" list on the home brief.

    Carries just enough to render the row without a second round-trip
    — the panel can deep-link to /api/spaces/{sid}/facts/{fact_uid}
    when the user clicks through.
    """

    fact_uid: str
    claim: str
    subject_label: str | None = None
    validated_at: datetime


class HomeBriefTopCluster(LucidBaseModel):
    """The dominant entity in the last-7d window.

    A `terms` aggregation over subject_uid (size=1) picks the bucket
    with the most validated facts. The bucket's uid is resolved to a
    human-readable name via a single lucid_objects get.

    When no fact lands in the window, all fields are null/zero so the
    UI can render an empty-state card without branching on shape.
    """

    entity_uid: str | None = None
    entity_name: str | None = None
    linked_count: int = 0


class HomeBrief(LucidBaseModel):
    """GET /api/home/brief envelope.

    `pending_validation` is a Postgres count (SourceJobORM rows whose
    status sits in the "ready for the user to decide" set — currently
    just `structured`). Every other field comes from ES (counts +
    bounded searches + one terms aggregation). All ES calls are wrapped
    in degrade-quietly try/except so a single failure can't 500 the
    response — fields zero/empty instead.

    `is_empty` is the convenience flag the home UI uses to flip into
    the onboarding state without re-checking totals.facts.
    """

    totals: HomeBriefTotals
    pending_validation: int
    recent_validated: list[HomeBriefRecentItem] = Field(default_factory=list)
    top_cluster: HomeBriefTopCluster
    is_empty: bool
