"""feat/spo-faithful-korean-decomp — schema relaxation tests.

The live regression observed today: a fresh capture produced facts=0
because StructureResult validation rejected the LLM response. The
6 rounds of constraint hardening (subject_surface mandate,
entity_type attempts, name_en requirements) interacted with
LucidBaseModel's `extra='forbid'` so a single LLM extra field on
StructureResult / StructureObject / StructureFactObjectLink killed
the entire envelope.

The fix: every LLM-intermediate model now overrides to
`extra='ignore'`. StructureFact and StructureFactFactLink already
had this. We add it to the other four.

This file pins the relaxation so a future cleanup can't silently
re-tighten the schema.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.structure.models import (
    StructureDisambiguation,
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)

# ---------------------------------------------------------------------------
# StructureObject — accepts LLM extras
# ---------------------------------------------------------------------------


def test_structure_object_ignores_extra_llm_fields() -> None:
    """Prior rounds had the LLM emitting `entity_type` and
    `person_origin` (instructions since removed). Even if the LLM
    drops a stray extra field, the parse should succeed."""
    payload = {
        "uid": "obj-1",
        "class": "organization",
        "name": "중국 상무부",
        "entity_type": "ministry",      # extra
        "person_origin": "China",       # extra
        "confidence": 0.92,             # extra
    }
    obj = StructureObject.model_validate(payload)
    assert obj.name == "중국 상무부"
    assert obj.name_en is None
    # Extras are silently dropped:
    assert not hasattr(obj, "entity_type")


def test_structure_object_minimal_required_only() -> None:
    """uid + class + name is the minimal valid payload. name_en,
    aliases, properties are all optional."""
    obj = StructureObject.model_validate({
        "uid": "obj-1",
        "class": "concept",
        "name": "loss aversion",
    })
    assert obj.aliases == []
    assert obj.properties == {}


# ---------------------------------------------------------------------------
# StructureResult — accepts LLM extras at the top level
# ---------------------------------------------------------------------------


def test_structure_result_ignores_top_level_extra_fields() -> None:
    """LLMs occasionally pad the envelope with `version`, `comment`,
    or a stray `meta`. None of these should fail validation."""
    result = StructureResult.model_validate({
        "objects": [],
        "facts": [],
        "fact_object_links": [],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
        "version": 2,                   # extra
        "comment": "looks good",        # extra
        "meta": {"k": "v"},            # extra
    })
    assert result.extraction_status == "success"


# ---------------------------------------------------------------------------
# StructureFact — fields stripped down to atomic SPO
# ---------------------------------------------------------------------------


def test_structure_fact_without_subject_surface() -> None:
    """The LLM may omit subject_surface entirely under the simpler
    prompt. The fact still parses; subject_surface defaults None and
    the processor's `_match_object` falls back to obj.name."""
    fact = StructureFact.model_validate({
        "uid": "fn-1",
        "type": "proposition",
        "claim": "중국 상무부는 발표했다.",
        "subject_uid": "obj-1",
        "predicate": "announced",
        "object_value": "수출통제 조치",
    })
    assert fact.subject_surface is None
    assert fact.object_surface is None


def test_structure_fact_without_object_surface_or_negation() -> None:
    """object_surface, negation_flag, negation_scope, tags_suggested
    are all optional. Atomic SPO content is what matters."""
    fact = StructureFact.model_validate({
        "uid": "fn-1",
        "type": "proposition",
        "claim": "OpenAI announced GPT-5.",
        "subject_uid": "obj-1",
        "predicate": "announced",
        "object_value": "GPT-5",
    })
    assert fact.negation_flag is False
    assert fact.negation_scope is None
    assert fact.tags_suggested == []


# ---------------------------------------------------------------------------
# StructureFactObjectLink — accepts extras
# ---------------------------------------------------------------------------


def test_structure_fact_object_link_ignores_extras() -> None:
    link = StructureFactObjectLink.model_validate({
        "fact_uid": "fn-1",
        "object_uid": "obj-1",
        "link_type": "involves",
        "properties": {},
        "confidence": 0.85,    # extra
    })
    assert link.link_type == "involves"


# ---------------------------------------------------------------------------
# Full minimal envelope — claim + subject.name + predicate + object only
# ---------------------------------------------------------------------------


def test_full_minimal_envelope_parses() -> None:
    """A real-world minimal LLM response: one object, one fact, no
    surface fields, no link tables. The whole envelope must parse."""
    minimal = {
        "objects": [
            {"uid": "obj-1", "class": "organization", "name": "중국"},
        ],
        "facts": [
            {
                "uid": "fn-1",
                "type": "proposition",
                "claim": "중국이 발표했다.",
                "subject_uid": "obj-1",
                "predicate": "announced",
                "object_value": "수출통제 조치",
            },
        ],
        "extraction_status": "success",
    }
    result = StructureResult.model_validate(minimal)
    assert result.extraction_status == "success"
    assert len(result.facts) == 1
    assert len(result.objects) == 1
    # Defaults filled in for omitted collections:
    assert result.fact_object_links == []
    assert result.fact_fact_links == []
    assert result.disambiguation_candidates == []


# ---------------------------------------------------------------------------
# StructureDisambiguation — accepts extras
# ---------------------------------------------------------------------------


def test_structure_disambiguation_minimal() -> None:
    d = StructureDisambiguation.model_validate({
        "fact_uid": "fn-1",
        "mention_text": "삼성",
        "rationale": "two candidates",  # extra
    })
    assert d.mention_text == "삼성"
    assert d.candidate_object_uids == []


# ---------------------------------------------------------------------------
# Regression: still rejects MISSING required fields
# ---------------------------------------------------------------------------


def test_structure_result_still_rejects_missing_required() -> None:
    """Relaxation is only about EXTRA fields. Missing required fields
    still raise ValidationError."""
    with pytest.raises(ValidationError):
        StructureResult.model_validate({
            # missing extraction_status
            "objects": [],
            "facts": [],
        })


def test_structure_object_still_rejects_missing_name() -> None:
    with pytest.raises(ValidationError):
        StructureObject.model_validate({
            "uid": "obj-1",
            "class": "organization",
            # missing name
        })
