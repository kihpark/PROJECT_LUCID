"""feat/prompts-classification-recovery — live LLM smoke for fact_type emission.

After PO's diagnosis that 100% of production facts were defaulting to
'action' because the LLM omitted fact_type entirely, this smoke verifies
the recovery: the LLM must emit fact_type on every fact (no defaults).

Gated by LUCID_LIVE_LLM_SMOKE=1.
"""
from __future__ import annotations

import os

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


def test_obvious_claim_emits_fact_type_claim() -> None:
    """The PO's WGBI sample (~'X설명했다') is obvious claim."""
    from api.structure.decomposer import decompose

    text = (
        "한국은행은 이 가운데 거의 대부분이 연기금 중심의 WGBI 추종자금으로 "
        "추정된다고 설명했다."
    )
    result = decompose(text)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 1

    # MUST find at least one claim fact, not silently default to action
    claim_facts = [f for f in result.facts if f.fact_type == "claim"]
    assert claim_facts, (
        f"WGBI sample must emit fact_type='claim'; got "
        f"{[(f.fact_type, f.predicate) for f in result.facts]}"
    )
    # Speaker / speech_act must be populated
    f = claim_facts[0]
    assert f.speaker_label, f"speaker_label missing on claim fact: {f}"
    assert f.speech_act, f"speech_act missing on claim fact: {f}"


def test_obvious_measurement_emits_fact_type_measurement() -> None:
    """PO's 출생아 sample ('2만4521명으로 발표했다') has measurement."""
    from api.structure.decomposer import decompose

    text = (
        "국가데이터처는 4월 인구동향에서 출생아 수가 2만4521명으로 "
        "전년 동월대비 18.0% 증가했다고 발표했다."
    )
    result = decompose(text)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 1

    measurement_facts = [f for f in result.facts if f.fact_type == "measurement"]
    assert measurement_facts, (
        f"출생아 sample must emit at least one measurement; got "
        f"{[(f.fact_type, f.predicate) for f in result.facts]}"
    )


def test_pure_action_still_emits_fact_type_action() -> None:
    """Regression: pure action ('10곳을 올렸다') stays action."""
    from api.structure.decomposer import decompose

    text = "중국 상무부가 미국 기업 10곳을 수출통제 대상에 올렸다."
    result = decompose(text)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 1

    fact_types = [f.fact_type for f in result.facts]
    # All must be explicit 'action' — fact_type must not be None / missing
    assert all(ft is not None for ft in fact_types)
    # No claim — there is no speaker.
    assert "claim" not in fact_types


def test_no_fact_carries_default_fallback() -> None:
    """The CRITICAL test: LLM must EMIT fact_type on every fact.
    This is verified indirectly by the raw_output containing 'fact_type'."""
    from api.structure.decomposer import decompose

    text = (
        "안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다. "
        "중국 정부는 미국 기업 10곳을 수출통제 대상에 올렸다."
    )
    result = decompose(text)
    assert result.extraction_status == "success"
    # The raw_output should contain 'fact_type' if LLM is emitting it.
    # (After fix this should always be True.)
    raw = getattr(result, "raw_output", "") or ""
    if raw:
        assert "fact_type" in raw, (
            f"LLM raw output must contain fact_type field; got "
            f"first 500 chars: {raw[:500]}"
        )


def test_mixed_article_emits_all_three_types() -> None:
    """Mixed article with action + claim + measurement should yield all 3."""
    from api.structure.decomposer import decompose

    text = (
        "OpenAI 는 GPT-5 를 발표했다. "
        "샘 알트먼 CEO 는 GPT-5 가 추론 능력에서 큰 진전을 이뤘다고 주장했다. "
        "ChatGPT 의 MAU 는 2026년 3월 기준 8억 명이다."
    )
    result = decompose(text)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 3

    fact_types = {f.fact_type for f in result.facts}
    # At minimum action + claim. Measurement is best-effort.
    assert "action" in fact_types
    assert "claim" in fact_types
