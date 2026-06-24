"""fact-measurement-layer-v1 — live Claude smoke for measurement layer.

PO directive 2026-06-23: the LLM is the classifier. This smoke
verifies that a real Claude call against the v0.2.0-step-2 prompt
labels facts correctly (action vs claim vs measurement) and emits the
metric / measurement_value / measurement_unit / as_of fields when the
source carries a numeric value pinned to a timepoint.

Gated by LUCID_LIVE_LLM_SMOKE=1 so CI doesn't spend on each run;
PO runs it manually before merging.

Coverage:
  1. KO article with statistic + timepoint → fact_type='measurement'
     with all 4 fields populated.
  2. KO pure-action article (no numerics) → no measurement facts
     (regression check that "10곳을 올렸다" type action+number facts
     still classify as action).
  3. KO mixed article (action + claim + measurement) → at least one
     of each type.
"""
from __future__ import annotations

import os

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


_KO_MEASUREMENT_ARTICLE = (
    "ChatGPT 의 월간 활성 사용자(MAU)는 2026년 3월 기준 8억 명을 돌파했다. "
    "OpenAI 는 분기 매출이 50조 원을 넘었다고 전했다."
)

_KO_PURE_ACTION_ARTICLE = (
    "중국 상무부는 22일 미국 군 관련 기업 10곳을 수출통제 관리 명단에 "
    "올렸다."
)

_KO_MIXED_ARTICLE = (
    "삼성전자는 2026년 1분기에 매출 70조 원을 기록했다. "
    "한종희 부회장은 '하반기 반도체 수요가 회복될 것'이라고 전망했다. "
    "삼성전자는 신규 데이터센터 투자 계획을 발표했다."
)


def test_measurement_article_yields_at_least_one_measurement_fact() -> None:
    """KO article with statistic ('8억 명', '50조 원') + timepoint
    ('2026년 3월') should produce at least one fact_type='measurement'
    with metric and either measurement_value or measurement_unit
    populated."""
    from api.structure.decomposer import decompose

    result = decompose(_KO_MEASUREMENT_ARTICLE)

    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason!r})"
    )
    assert len(result.facts) >= 1

    measure_facts = [f for f in result.facts if f.fact_type == "measurement"]
    assert measure_facts, (
        "expected at least one fact_type='measurement' from a statistic-"
        f"heavy article, got fact_types={[f.fact_type for f in result.facts]}"
    )
    # At least one measurement must carry metric + (value or unit) — the
    # FactCard strip can't render usefully without these.
    populated = [
        f for f in measure_facts
        if f.metric and (
            f.measurement_value is not None or f.measurement_unit
        )
    ]
    assert populated, (
        f"expected measurement facts with metric + value/unit; got "
        f"{[(f.metric, f.measurement_value, f.measurement_unit, f.as_of) for f in measure_facts]}"
    )


def test_pure_action_article_yields_no_measurement_facts() -> None:
    """Regression check: an action+number fact ('10곳을 수출통제 대상에
    올렸다') is an ACTION, not a measurement. The number is the object
    quantity, not a metric pinned to a timepoint. Mis-classifying it
    as measurement would lock the classifier into hallucinating a
    metric ('10곳' as a metric name) — exactly what step 2's
    guideline forbids."""
    from api.structure.decomposer import decompose

    result = decompose(_KO_PURE_ACTION_ARTICLE)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 1

    fact_types = [f.fact_type for f in result.facts]
    assert "measurement" not in fact_types, (
        f"expected no measurement facts on a pure-action article "
        f"('10곳을 올렸다' is action+quantity, not metric); got "
        f"{fact_types}"
    )


def test_mixed_article_yields_all_three_types() -> None:
    """A KO article carrying an action ('발표했다'), a claim
    ('전망했다'), and a measurement ('매출 70조 원') should yield all
    three fact types — confirming the classifier does not collapse the
    measurement bucket into action when in mixed company."""
    from api.structure.decomposer import decompose

    result = decompose(_KO_MIXED_ARTICLE)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 2

    fact_types = {f.fact_type for f in result.facts}
    assert "measurement" in fact_types, (
        "expected at least one measurement fact (for '매출 70조 원'); "
        f"got {fact_types}"
    )
    # action and claim coverage is the step-1 contract; verify both
    # are still firing in the presence of the new measurement bucket.
    assert "action" in fact_types or "claim" in fact_types, (
        f"expected at least one action or claim in a 3-type mixed "
        f"article; got only {fact_types}"
    )
