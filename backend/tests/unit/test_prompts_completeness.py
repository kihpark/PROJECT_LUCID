"""feat/spo-decomp-completeness — pin the completeness clause in prompt.

PO directive (2026-06-23): the prior simplification swung past the
sweet spot — predicates dropped to bare verbs ("올렸다") and objects to
noun-slivers ("10곳"). This test pins the new completeness clause:

  1. The "RULE — 완전성" label is present.
  2. Both PO live-evidence examples are baked in as worked anti-examples
     so the LLM has a concrete target.
  3. The "자르기만, 내용 추가 금지" prohibition survives (anti-summarization).
"""
from __future__ import annotations

from api.structure.prompts import SYSTEM_PROMPT


def test_completeness_rule_clause_present() -> None:
    """The new clause is anchored by a recognizable label and the
    operative token '완전성'.
    """
    assert "RULE — 완전성" in SYSTEM_PROMPT
    # The token '완전성' anchors the meaning-coverage rule
    assert "완전성" in SYSTEM_PROMPT
    # The 합쳐서 / 핵심 의미 / 보존 chain (the rule's core principle)
    assert "합쳐서" in SYSTEM_PROMPT
    assert "핵심" in SYSTEM_PROMPT
    # Anti-summarization clause is present (PO's "자르기만, 내용 추가 금지")
    assert "자르기만" in SYSTEM_PROMPT
    assert "내용 추가 금지" in SYSTEM_PROMPT


def test_completeness_worked_examples_present() -> None:
    """Both PO live-evidence cases appear as worked anti-examples in
    the prompt body.

    Case 1: 수출통제 대상에 올렸다 / 미국 기업 10곳
    Case 2: 추가 제재에 나섰다  / 미국 방산·드론·희토류 관련 기업
    """
    # Case 1 anchors
    assert "수출통제 대상에 올렸다" in SYSTEM_PROMPT
    assert "미국 기업 10곳" in SYSTEM_PROMPT
    # Case 2 anchors
    assert "추가 제재에 나섰다" in SYSTEM_PROMPT
    assert "방산·드론·희토류" in SYSTEM_PROMPT
    # The bare-verb anti-example is shown so the LLM sees the contrast
    assert "NOT" in SYSTEM_PROMPT  # used in 'NOT "올렸다"' line
