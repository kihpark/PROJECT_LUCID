"""feat/spo-faithful-korean-decomp — live Claude smoke.

PO directive (2026-06-23): the canonical failure observed today was
'StructureResult schema validation failed: 2 validation errors →
facts=0'. The 6 rounds of constraint hardening + Pydantic strictness
made the natural LLM response fail validation.

This smoke catches that exact regression with a single real Claude
call against the simplified prompt + relaxed schema. Gated by
LUCID_LIVE_LLM_SMOKE=1 so CI doesn't spend ~$0.01 per run; PO
runs it manually before merging this PR.

Differs from test_claude_live.py in scope:
  - test_claude_live: "does decompose return any facts at all"
  - test_claude_faithful: "does the simplified prompt make the
    LLM emit Korean-language SPO content under the relaxed
    schema, without ValidationError"
"""

from __future__ import annotations

import os
import re

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


_KOREAN_TEST_ARTICLE = (
    "중국 상무부는 22일 미국 군 관련 기업 10곳을 수출통제 관리 명단에 "
    "올렸다고 발표했다. 이번 조치는 미국의 대중 반도체 수출통제에 대한 "
    "맞대응으로 평가된다."
)

_ENGLISH_TEST_ARTICLE = (
    "On June 22, 2026, OpenAI announced GPT-5, claiming significant "
    "improvements in reasoning and tool use. The product launches "
    "to enterprise customers next month."
)


def _has_hangul(s: str) -> bool:
    return bool(re.search(r"[가-힯]", s))


def test_faithful_korean_decomp_yields_korean_facts() -> None:
    """Korean article → status=success, >=1 fact, NO schema
    validation errors. At least one fact must carry Korean content
    in either claim or object_value (proving the LLM stayed in
    source language)."""
    from api.structure.decomposer import decompose

    result = decompose(_KOREAN_TEST_ARTICLE)

    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason!r})"
    )
    # This is the exact failure shape the 6th-round main produced:
    # facts=0 + failure_reason=malformed_llm_output. Catching it
    # here proves the relaxed schema + simpler prompt fixed it.
    assert result.failure_reason != "malformed_llm_output", (
        "live regression: Pydantic validation killed the envelope "
        "before the prompt could deliver facts"
    )
    assert len(result.facts) >= 1
    assert result.failure_reason is None

    # Korean content faithful: at least the claim should be Korean.
    korean_claims = [f for f in result.facts if _has_hangul(f.claim)]
    assert korean_claims, (
        f"expected at least one Korean-claim fact, got "
        f"{[f.claim for f in result.facts]}"
    )


def test_faithful_english_decomp_yields_english_facts() -> None:
    """English article control: stays English."""
    from api.structure.decomposer import decompose

    result = decompose(_ENGLISH_TEST_ARTICLE)

    assert result.extraction_status == "success"
    assert result.failure_reason is None
    assert len(result.facts) >= 1

    # English content faithful: at least one fact's claim has no
    # Hangul.
    english_claims = [f for f in result.facts if not _has_hangul(f.claim)]
    assert english_claims, (
        f"expected at least one English-claim fact, got "
        f"{[f.claim for f in result.facts]}"
    )
