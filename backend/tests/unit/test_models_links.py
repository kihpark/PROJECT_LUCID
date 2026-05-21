"""Unit tests for backend/api/models/links.py."""
from __future__ import annotations

from api.models.base import new_uid
from api.models.links import (
    FactFactLinkType,
    FactObjectLinkType,
    LinkRecord,
    ObjectObjectLinkType,
)


def test_fact_object_link_types_count():
    """Five Fact-to-Object link types."""
    assert len(FactObjectLinkType) == 5
    expected = {"asserts_property", "describes_state", "addresses", "uses", "involves"}
    assert {member.value for member in FactObjectLinkType} == expected


def test_object_object_link_types_count():
    """Four Object-to-Object link types."""
    assert len(ObjectObjectLinkType) == 4
    expected = {"part_of", "instance_of", "located_in", "has_role"}
    assert {member.value for member in ObjectObjectLinkType} == expected


def test_fact_fact_link_types_count():
    """Six Fact-to-Fact link types."""
    assert len(FactFactLinkType) == 6
    expected = {
        "supports",
        "contradicts",
        "example_of",
        "derived_from",
        "interprets",
        "supersedes",
    }
    assert {member.value for member in FactFactLinkType} == expected


def test_link_record_minimal():
    lr = LinkRecord(
        from_uid=new_uid(),
        to_uid=new_uid(),
        link_type="supports",
    )
    assert lr.weight == 1.0
    assert lr.created_at.tzinfo is not None
