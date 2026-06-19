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


class RecallFacets(LucidBaseModel):
    """Aggregations over the CURRENT filtered result set.

    Recomputed on every recall call so the drill-down (entities[])
    narrows the facet view at the same time as the central result
    list. No bucket is sticky.
    """

    entities: EntityFacets = Field(default_factory=lambda: EntityFacets())
    predicates: list[PredicateFacetItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# B-48b — fact detail
# ---------------------------------------------------------------------------

class FactDetailHeader(LucidBaseModel):
    """The fact's own row, rendered with labels already resolved."""

    fact_uid: str
    claim: str
    claim_en: str | None = None
    subject_uid: str
    subject_label: str | None = None
    predicate: str
    object_value: str
    object_label: str | None = None
    validated_at: datetime
    retracted_at: datetime | None = None
    retracted_by: str | None = None
    edit_history: list[dict] = Field(default_factory=list)


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


class FactMutationResponse(LucidBaseModel):
    """Response shared by retract / restore / detach-source — the
    client uses the returned fact_uid to redraw / close the panel
    and the `retracted_at` to flip the visual state."""

    fact_uid: str
    retracted_at: datetime | None = None
    source_uids: list[str] = Field(default_factory=list)
    auto_retracted: bool = False


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
