"""Live Claude API smoke - exercises the actual decompose() against real Claude.

Gated by env var LUCID_LIVE_LLM_SMOKE=1. CI / agent runs skip by default.
PO runs manually before shipping prompt-changing PRs.

The test catches prompt-format breakage that mocked tests cannot see - e.g.
when a prompt update causes Claude to emit ```json``` markdown fences that
the JSON parser cannot handle (the exact failure that took down live capture
on 2026-06-22).

Cost: ~2 Claude calls per run (~$0.01 each). Run before any prompt-changing
PR; do not run on every PR.
"""

from __future__ import annotations

import os

import pytest

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


def test_decompose_korean_article_returns_facts() -> None:
    """A short Korean article should return >=1 fact with status='success'."""
    from api.structure.decomposer import decompose

    text = (
        "중국 상무부는 22일 미국 군 관련 기업 10곳을 수출통제 관리 명단에 "
        "올렸다고 발표했다. 이번 조치는 미국의 대중 반도체 수출통제에 대한 "
        "맞대응으로 평가된다."
    )
    result = decompose(text)

    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason})"
    )
    assert len(result.facts) >= 1
    # No JSON parse failures
    assert result.failure_reason is None


def test_decompose_english_article_returns_facts() -> None:
    """An English article should also extract facts (control case)."""
    from api.structure.decomposer import decompose

    text = (
        "On June 22, 2026, China's Ministry of Commerce announced that ten "
        "US military-related companies have been added to its export control "
        "list. The move is widely seen as retaliation against US semiconductor "
        "export controls."
    )
    result = decompose(text)

    assert result.extraction_status == "success"
    assert len(result.facts) >= 1
    assert result.failure_reason is None
