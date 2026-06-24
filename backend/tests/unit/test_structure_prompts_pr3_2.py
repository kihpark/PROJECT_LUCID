"""Unit tests for PR-3-2 prompts.py revisions."""
from __future__ import annotations

from api.structure.prompts import FEW_SHOT_EXAMPLES, SYSTEM_PROMPT


def test_nine_few_shot_examples_total():
    """PR-3-1 shipped 3, PR-3-2 appended 3 → 6.
    v0.2.0 step 1 (fact-claim-layer-v1) appends 3 more for the
    Action vs Claim split (action / claim-neutral / claim-critical)
    → 9.
    v0.2.0 step 2 (fact-measurement-layer-v1) appends 2 more for the
    Measurement bucket (MAU + 실업률) → 11 total."""
    assert len(FEW_SHOT_EXAMPLES) == 11


def test_ko_statistic_example_present():
    """KO single-statistic proposition (한국은행 기준금리 3.0%)."""
    blob = "\n".join(repr(ex) for ex in FEW_SHOT_EXAMPLES)
    assert "한국은행" in blob or "기준금리" in blob


def test_ko_multi_fact_compound_example_present():
    """KO multi-fact compound (삼성전자 영업이익 + 부문별)."""
    blob = "\n".join(repr(ex) for ex in FEW_SHOT_EXAMPLES)
    assert "삼성전자" in blob and "영업이익" in blob


def test_ko_homonym_example_present():
    """KO homonym disambig (삼성 — 1938 founded)."""
    blob = "\n".join(repr(ex) for ex in FEW_SHOT_EXAMPLES)
    assert "1938" in blob


def test_forecast_conditional_added_to_step_4():
    """PR-3-2 added forecast/conditional triggers to negation_ambiguous."""
    assert "Forecast / conditional" in SYSTEM_PROMPT
    assert "할 수도" in SYSTEM_PROMPT
    assert "perhaps not" in SYSTEM_PROMPT


def test_ambiguous_negation_emits_no_facts_rule_intact():
    """The ambiguous-negation rule must still say no facts are emitted."""
    assert "negation_ambiguous" in SYSTEM_PROMPT
    assert "no facts" in SYSTEM_PROMPT.lower()


def test_ko_multi_compound_emits_supports_links():
    """Multi-fact compound example uses fact_fact 'supports' links."""
    for ex in FEW_SHOT_EXAMPLES:
        if "영업이익" in repr(ex):
            ff_links = ex["output"]["fact_fact_links"]
            assert any(lnk["link_type"] == "supports" for lnk in ff_links)
            break
    else:
        raise AssertionError("KO multi-fact example not found")
