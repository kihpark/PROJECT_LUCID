"""Unit: structure/decomposer.py + structure/models.py."""
from __future__ import annotations

from unittest.mock import patch

from api.structure import StructureResult, decompose
from api.structure.models import (
    StructureFact,
    StructureFactFactLink,
    StructureFactObjectLink,
    StructureObject,
)


def test_structure_result_default_shape():
    """Empty StructureResult validates with required fields only."""
    r = StructureResult(extraction_status="no_facts_found")
    assert r.facts == []
    assert r.objects == []
    assert r.failure_reason is None


def test_structure_fact_negation_scope_enforced():
    """Pydantic Literal blocks unknown negation_scope strings."""
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        StructureFact(
            uid="fn-1", claim="x", type="proposition",
            subject_uid="obj-1", predicate="p", object_value="o",
            negation_flag=True, negation_scope="kinda",  # type: ignore[arg-type]
        )


def test_structure_fact_fact_link_negates_member():
    """NEGATES is one of the 7 fact↔fact link types (DCR-001)."""
    link = StructureFactFactLink(
        from_uid="fn-1", to_uid="fn-2", link_type="negates"
    )
    assert link.link_type == "negates"


def test_structure_fact_object_link_5_types_enforced():
    """Fact↔Object link_type is one of the 5 enum values."""
    import pytest
    from pydantic import ValidationError

    for ok in ("asserts_property", "describes_state", "addresses", "uses", "involves"):
        StructureFactObjectLink(fact_uid="fn", object_uid="obj", link_type=ok)  # type: ignore[arg-type]

    with pytest.raises(ValidationError):
        StructureFactObjectLink(
            fact_uid="fn", object_uid="obj", link_type="hugged"  # type: ignore[arg-type]
        )


def test_decompose_calls_through_to_claude_client():
    """decompose() is a thin wrapper around decompose_via_claude."""
    fake_result = StructureResult(extraction_status="success", facts=[], objects=[])

    with patch(
        "api.structure.decomposer.decompose_via_claude", return_value=fake_result
    ) as mocked:
        out = decompose("text", {"source_url": "https://x"})
    assert out is fake_result
    args, _ = mocked.call_args
    assert args[0] == "text"
    assert args[1] == {"source_url": "https://x"}
