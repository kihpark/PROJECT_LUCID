"""fact-claim-layer-v1 — live Claude smoke for the Action vs Claim split.

PO directive 2026-06-23: the LLM is the classifier. This smoke
verifies that a real Claude call against the v0.2.0-step-1 prompt
labels facts correctly (action vs claim) and emits the speaker /
speech_act / content_claim / stance fields when the source carries
quotation / opinion verbs (밝혔다, 주장했다, 전망했다, 부인했다).

Gated by LUCID_LIVE_LLM_SMOKE=1 so CI doesn't spend on each run;
PO runs it manually before merging.
"""
from __future__ import annotations

import os

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


_KO_QUOTATION_ARTICLE = (
    "안도걸 더불어민주당 의원은 22일 디지털자산기본법 제정에 속도를 낼 "
    "것이라고 밝혔다. 안 의원은 '국내 가상자산 시장의 제도화가 시급하다'고 "
    "강조했다."
)

_KO_PURE_ACTION_ARTICLE = (
    "중국 상무부는 22일 미국 군 관련 기업 10곳을 수출통제 관리 명단에 "
    "올렸다."
)

_KO_MIXED_ARTICLE = (
    "OpenAI 는 GPT-5 를 발표했다. 샘 알트먼 CEO 는 GPT-5 가 추론 능력에서 "
    "큰 진전을 이뤘다고 주장했다."
)


def test_quotation_article_yields_at_least_one_claim_fact() -> None:
    """KO article with quotation verbs ('밝혔다', '강조했다') should
    produce at least one fact_type='claim' with speaker_label and
    speech_act populated."""
    from api.structure.decomposer import decompose

    result = decompose(_KO_QUOTATION_ARTICLE)

    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason!r})"
    )
    assert len(result.facts) >= 1

    claim_facts = [f for f in result.facts if f.fact_type == "claim"]
    assert claim_facts, (
        "expected at least one fact_type='claim' from a quotation-heavy "
        f"article, got fact_types={[f.fact_type for f in result.facts]}"
    )
    # At least one claim must carry both speaker_label and speech_act —
    # the FactCard strip can't render usefully without them.
    populated = [
        f for f in claim_facts
        if f.speaker_label and f.speech_act
    ]
    assert populated, (
        f"expected claim facts with speaker_label + speech_act; got "
        f"{[(f.speaker_label, f.speech_act) for f in claim_facts]}"
    )


def test_pure_action_article_yields_no_claim_facts() -> None:
    """A KO article with only event verbs ('발표했다', '올렸다')
    should produce only fact_type='action' facts."""
    from api.structure.decomposer import decompose

    result = decompose(_KO_PURE_ACTION_ARTICLE)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 1

    fact_types = [f.fact_type for f in result.facts]
    # No claim facts allowed on a pure-action article. ('발표했다'
    # is a borderline verb but the prompt classification guide pins
    # it to action.)
    assert "claim" not in fact_types, (
        f"expected only action facts on a pure-action article, got "
        f"{fact_types}"
    )


def test_mixed_article_yields_both_types() -> None:
    """A KO article carrying both an action ('발표했다') and a claim
    ('주장했다') should yield both fact types."""
    from api.structure.decomposer import decompose

    result = decompose(_KO_MIXED_ARTICLE)
    assert result.extraction_status == "success"
    assert len(result.facts) >= 2

    fact_types = {f.fact_type for f in result.facts}
    assert "action" in fact_types, (
        f"expected at least one action fact (for '발표했다'); got {fact_types}"
    )
    assert "claim" in fact_types, (
        f"expected at least one claim fact (for '주장했다'); got {fact_types}"
    )
