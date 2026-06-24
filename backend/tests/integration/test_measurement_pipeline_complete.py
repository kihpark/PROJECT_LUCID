"""Integration tests for feat/measurement-completeness (v0.2.0 step 2.5).

PO directive 2026-06-24: the measurement fact's completeness check must
run via `check_measurement_completeness` (not the SPO `check_completeness`)
because the measurement claim's content is carried in the
(entity, metric, value, unit, as_of) quadruple, not in the SPO triple.

The processor's `_serialize_struct_fact` now branches on `fact_type`:
  - 'measurement' → `check_measurement_completeness`
  - anything else (action / claim / legacy) → `check_completeness` (SPO)

These tests lock the branch contract end-to-end on the serialiser:
  1. A rich measurement fact passes completeness; needs_review=False.
  2. A thin metric (the PO 노사 case) fails completeness; needs_review=True
     with the missing tokens surfaced.
  3. as_of=null + claim mentions an application time → still classified
     and surface preserved; thin-metric check still flags incompleteness.
"""
from __future__ import annotations

import pytest

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact

pytestmark = pytest.mark.integration


def _rich_noso_fact() -> StructureFact:
    """The GOOD shape from PO's 노사 directive — rich metric, null
    as_of, value+unit populated, entity_label propagates via subject."""
    return StructureFact.model_validate({
        "uid": "fn-noso-good",
        "type": "proposition",
        "claim": "노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.",
        "subject_uid": "obj-1",
        "predicate": "시급 기준 차이이다",
        "object_value": "1680원",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "measurement",
        "metric": "노사 양측의 최초 요구안 차이 (시급 기준)",
        "measurement_value": 1680.0,
        "measurement_unit": "원",
        "as_of": None,
    })


def _thin_noso_fact() -> StructureFact:
    """The BAD shape PO captured live — thin metric, polluted as_of."""
    return StructureFact.model_validate({
        "uid": "fn-noso-bad",
        "type": "proposition",
        "claim": "노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.",
        "subject_uid": "obj-1",
        "predicate": "차이이다",
        "object_value": "1680원",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "measurement",
        "metric": "최초 요구안 차이",
        "measurement_value": 1680.0,
        "measurement_unit": "원",
        # The application-time pollution — PO captured "2027" here in
        # the bug report. Even with this value, the metric thinness
        # alone tanks coverage.
        "as_of": "2027",
    })


def _application_time_fact() -> StructureFact:
    """An application-time case where `as_of=null` is correct but the
    metric STILL lacks the 주체 qualifier. Surface (claim) preserves
    "2027년 적용"; we expect needs_review=True because the metric is
    still thin and entity is missing too.
    """
    return StructureFact.model_validate({
        "uid": "fn-apply",
        "type": "proposition",
        "claim": "2027년 적용 최저임금은 시급 기준 1만 320원이다.",
        "subject_uid": "obj-1",
        "predicate": "시급 기준이다",
        "object_value": "1만 320원",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "measurement",
        "metric": "최저임금",
        "measurement_value": 10320.0,
        "measurement_unit": "원",
        "as_of": None,  # correctly null — application time, not measurement
    })


# ---------------------------------------------------------------------------


def test_rich_measurement_passes_completeness() -> None:
    """The GOOD 노사 fact's serialised dict should have
    completeness.complete=True and needs_review=False (modulo other
    flags from the SPO surface check — predicate_violation etc., but
    those don't fire for a clean Korean claim).
    """
    fact = _rich_noso_fact()
    d = _serialize_struct_fact(fact)
    completeness = d["completeness"]
    assert completeness["complete"] is True, (
        f"expected complete=True; got {completeness}"
    )
    # coverage must exceed the 0.7 threshold for the GOOD shape
    assert completeness["coverage"] >= 0.7


def test_thin_measurement_flags_needs_review() -> None:
    """The BAD 노사 fact — thin metric drops 主체 / 기준 qualifiers.
    `needs_review` must flip True, `completeness.complete` False,
    and the dropped tokens must be visible in `missing` so the Decide
    UI can highlight what to fix.
    """
    fact = _thin_noso_fact()
    d = _serialize_struct_fact(fact)
    completeness = d["completeness"]
    assert completeness["complete"] is False
    assert d["needs_review"] is True
    missing = set(completeness["missing"])
    # 主체 (노사 / 양측) and 기준 (시급) must surface
    assert "노사" in missing
    assert "양측" in missing
    assert "시급" in missing


def test_application_time_fact_classifies_and_preserves_surface() -> None:
    """For an application-time case the prompt rule says as_of=null.
    The serialiser must still keep `claim` verbatim (so the 2027 hint
    isn't lost) and must still run the measurement validator (not the
    SPO one). If the metric is thin (no 주체 / 기준 qualifier), the
    fact is correctly flagged — proving the validator is wired.
    """
    fact = _application_time_fact()
    d = _serialize_struct_fact(fact)
    # surface preserved verbatim
    assert d["claim"] == "2027년 적용 최저임금은 시급 기준 1만 320원이다."
    # fact_type preserved
    assert d["fact_type"] == "measurement"
    # measurement quadruple preserved (null as_of is intentional)
    assert d["metric"] == "최저임금"
    assert d["measurement_value"] == 10320.0
    assert d["measurement_unit"] == "원"
    assert d["as_of"] is None
    # the thin metric (no 시급/기준 qualifier in `metric`) means
    # completeness fails — the validator is wired correctly.
    completeness = d["completeness"]
    assert completeness["complete"] is False
    missing = set(completeness["missing"])
    # at least one of 시급 / 기준 must be flagged missing
    assert any(t in missing for t in ("시급", "기준"))
