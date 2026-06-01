"""Link Types for the Lucid graph.

The CSVS specs canonicalize 15 link types across three axes:
  Fact <-> Object   (5)
  Object <-> Object (4)
  Fact <-> Fact     (6)

A 16th, Fact <-> Source, lives on FactNode.source_uids and is not
modelled as a LinkRecord (it is a direct list reference).
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now


class FactObjectLinkType(StrEnum):
    """Five Fact-to-Object link types."""

    ASSERTS_PROPERTY = "asserts_property"
    DESCRIBES_STATE = "describes_state"
    ADDRESSES = "addresses"
    USES = "uses"
    INVOLVES = "involves"


class ObjectObjectLinkType(StrEnum):
    """Four Object-to-Object link types."""

    PART_OF = "part_of"
    INSTANCE_OF = "instance_of"
    LOCATED_IN = "located_in"
    HAS_ROLE = "has_role"


class FactFactLinkType(StrEnum):
    """Seven Fact-to-Fact link types.

    DCR-001 (2026-05-28) added NEGATES.  NEGATES vs CONTRADICTS:
      - CONTRADICTS  symmetric; two facts whose claims cannot both be true.
      - NEGATES      directional; this fact is the explicit negative
                     statement of the target fact. The negating party
                     carries `negation_flag=True` (see api.models.facts).
    """

    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    EXAMPLE_OF = "example_of"
    DERIVED_FROM = "derived_from"
    INTERPRETS = "interprets"
    SUPERSEDES = "supersedes"
    NEGATES = "negates"  # DCR-001


# Type alias covering the union of all three link-type enums.
# Stored on LinkRecord as a string; the API layer validates against the
# correct enum given the from/to types.
class LinkRecord(LucidBaseModel):
    """One graph edge.

    The `link_type` field is held as a plain string here so the same
    LinkRecord type covers all three axes. Routes that create LinkRecord
    instances validate `link_type` against the matching enum based on
    the from/to node types.

    ``link_nuance`` (DCR-002 v2, DR-066) is an optional free-form modifier
    that narrows the meaning of ``link_type`` without expanding the
    canonical 15-axis ontology. The beta data model just stores the
    string; Phase 1+ LLM decomposition will populate it and the
    Synergy Layer will key on it.

    Free-form guidance (illustrative only — link_nuance accepts any string):

      DERIVED_FROM
        - "causal"         — caused by the referenced fact
        - "responsive"     — a market / policy / behavioural response
        - "evolutionary"   — incremental evolution
        - "inspirational"  — inspired by but not strictly entailed

      SUPPORTS
        - "evidence"       — empirical evidence
        - "mechanism"      — proposed mechanism
        - "case"           — case study / anecdote

      SUPERSEDES
        - "improved"       — better instance of the same idea
        - "outdated"       — original is now stale
        - "scope_shift"    — applicability changed

      CONTRADICTS
        - "direct"         — values literally inconsistent
        - "scope"          — both can be true under different scope
        - "temporal"       — both can be true at different times

    None / unset → behave as a plain link of the named type (backward
    compatible with everything written before DCR-002 v2).
    """

    from_uid: UID
    to_uid: UID
    link_type: str
    link_nuance: str | None = None
    weight: float = 1.0
    created_at: datetime = Field(default_factory=utc_now)
