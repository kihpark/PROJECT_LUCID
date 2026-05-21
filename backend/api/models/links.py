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
    """Six Fact-to-Fact link types."""

    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    EXAMPLE_OF = "example_of"
    DERIVED_FROM = "derived_from"
    INTERPRETS = "interprets"
    SUPERSEDES = "supersedes"


# Type alias covering the union of all three link-type enums.
# Stored on LinkRecord as a string; the API layer validates against the
# correct enum given the from/to types.
class LinkRecord(LucidBaseModel):
    """One graph edge.

    The `link_type` field is held as a plain string here so the same
    LinkRecord type covers all three axes. Routes that create LinkRecord
    instances validate `link_type` against the matching enum based on
    the from/to node types.
    """

    from_uid: UID
    to_uid: UID
    link_type: str
    weight: float = 1.0
    created_at: datetime = Field(default_factory=utc_now)
