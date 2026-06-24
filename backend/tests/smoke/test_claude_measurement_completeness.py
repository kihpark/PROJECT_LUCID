"""feat/measurement-completeness — live Claude smoke for measurement v0.2.0 step 2.5.

PO directive 2026-06-24: with the prompt strengthening (rich-metric rule +
as_of disambiguation), Claude must:

  1. Emit measurement facts whose `metric` includes 主체 + 기준 qualifiers
     (not the thin "차이" / "MAU" / "매출" toks the layer was shipping in
     step 2).
  2. Set `as_of=null` when the source has application/시행/발효 time only
     (not measurement time).
  3. Still set `as_of` correctly when the source DOES carry a measurement
     timepoint (regression).

Gated by LUCID_LIVE_LLM_SMOKE=1 so CI doesn't spend on each run.

Coverage:
  1. 노사 case (PO's verbatim bug)
  2. ChatGPT MAU case (measurement time present — as_of correctly populated)
  3. Application-time case (as_of correctly null OR fact still measurement)
"""
from __future__ import annotations

import os

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


_KO_NOSO_ARTICLE = (
    "노사 양측의 최초 요구안 차이는 시급 기준 1680원이다. "
    "노동계는 시급 1만 1500원을, 경영계는 9820원을 제시했다."
)

_KO_MAU_ARTICLE = (
    "ChatGPT 의 월간 활성 사용자(MAU)는 2026년 3월 기준 8억 명을 돌파했다. "
    "이는 전월 대비 12% 증가한 수치다."
)

_KO_APPLICATION_TIME_ARTICLE = (
    "2027년 적용 최저임금은 시급 기준 1만 320원으로 결정됐다. "
    "최저임금위원회는 22일 의결했다."
)


def test_noso_metric_includes_qualifiers() -> None:
    """The 노사 article must produce a measurement fact whose `metric`
    carries at least one of the 主체 qualifier (`노사` / `양측`) or 기준
    qualifier (`시급`). The thin "차이" alone is the bug PO captured.
    """
    from api.structure.decomposer import decompose

    result = decompose(_KO_NOSO_ARTICLE)

    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason!r})"
    )

    measure_facts = [f for f in result.facts if f.fact_type == "measurement"]
    assert measure_facts, (
        f"expected at least one fact_type='measurement' from 노사 article; "
        f"got fact_types={[f.fact_type for f in result.facts]}"
    )

    # At least one measurement's metric must include a qualifier token.
    metrics = [f.metric or "" for f in measure_facts]
    has_qualifier = any(
        any(q in m for q in ("노사", "양측", "시급", "기준"))
        for m in metrics
    )
    assert has_qualifier, (
        f"expected at least one measurement.metric to include a 주체/기준 "
        f"qualifier (노사/양측/시급/기준); got metrics={metrics!r}"
    )


def test_mau_article_emits_measurement_time_as_of() -> None:
    """The MAU article has '2026년 3월 기준' — Claude should set
    as_of='2026-03' (or '2026-3' / '2026'). This is the regression
    check that as_of disambiguation didn't accidentally null out
    legitimate measurement timepoints.
    """
    from api.structure.decomposer import decompose

    result = decompose(_KO_MAU_ARTICLE)
    assert result.extraction_status == "success"
    measure_facts = [f for f in result.facts if f.fact_type == "measurement"]
    assert measure_facts

    # At least one measurement should carry a 2026-03 / 2026 / 2026-3 as_of.
    as_ofs = [f.as_of or "" for f in measure_facts]
    has_measurement_time = any(
        "2026" in a for a in as_ofs
    )
    assert has_measurement_time, (
        f"expected at least one measurement.as_of to carry a 2026 timepoint "
        f"(measurement time '2026년 3월 기준'); got as_ofs={as_ofs!r}"
    )


def test_application_time_article_does_not_pollute_as_of() -> None:
    """The application-time article has '2027년 적용' — Claude should
    either:
      (a) emit a measurement fact with as_of=null (preferred per
          prompt rule), OR
      (b) decline measurement classification entirely.

    What it MUST NOT do: emit as_of='2027' on a fact where 2027 is
    only an application timepoint. The surface (claim) preserves the
    2027 hint either way (faithful claim is invariant).
    """
    from api.structure.decomposer import decompose

    result = decompose(_KO_APPLICATION_TIME_ARTICLE)
    assert result.extraction_status == "success"
    measure_facts = [f for f in result.facts if f.fact_type == "measurement"]

    if measure_facts:
        # If classified as measurement, as_of must be null OR not literally
        # the application year '2027'. A `2027` alone is the regression bug.
        for f in measure_facts:
            assert f.as_of != "2027", (
                f"as_of='2027' is the PO-flagged application-time pollution; "
                f"prompt rule v0.2.0 step 2.5 says null is correct here. "
                f"fact={f.metric!r} value={f.measurement_value!r} unit={f.measurement_unit!r}"
            )
    # If not classified as measurement, the surface (claim) is still
    # preserved on the action/claim facts — no information lost.
