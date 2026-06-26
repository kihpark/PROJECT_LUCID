"""fix/r1-recall-redesign — LIVE Claude smoke for /recall/briefing.

PO directive (Step 2): "프롬프트/추출/임베딩 건드리면 실제 Claude/OpenAI
smoke 필수 (mock 으론 라이브 버그 못 잡음 — 분류 죽었던 전례)."

This smoke does NOT mock Claude. It builds a synthetic verified-fact
list, calls the briefing prompt path against the real Anthropic API,
and asserts:

  · The LLM returns parseable JSON (proves the system prompt + the
    JSON-mode contract still hold).
  · The cited_fact_uids contain at least one uid from the input set
    (proves the grounding instruction works — the LLM can name what
    it leaned on).
  · The briefing text is non-empty and reads like Korean (proves the
    persona / language instruction took).

Run requirements: ANTHROPIC_API_KEY must be set in the env. Skips
otherwise so the CI suite (which doesn't have keys) doesn't fail.
"""
from __future__ import annotations

import json
import os

import pytest

pytestmark = pytest.mark.smoke


def _have_key() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


@pytest.fixture(autouse=True)
def _skip_without_key():
    if not _have_key():
        pytest.skip("ANTHROPIC_API_KEY not set; live smoke skipped")


def _facts_block() -> str:
    """Three synthetic verified facts about a fake entity — gives the
    LLM enough material to compose a 1-3 sentence overview."""
    return "\n".join([
        "[fact-A] 선거관리위원회 공고함 투표 용지 디자인 2026-06-15",
        "[fact-B] 선거관리위원회 발표함 사전투표율 12.3%",
        "[fact-C] 선거관리위원회 점검함 개표소 보안 시스템",
    ])


def _call_briefing_llm(query: str, facts_text: str, total_facts: int) -> dict:
    """Invoke the live briefing prompt path. Mirrors what
    api.routes.recall.recall_briefing does end-to-end so a bug in the
    prompt or parser shows up here, not only in production."""
    from api.routes.recall import (
        BRIEFING_SYSTEM_PROMPT,
        _build_briefing_user_prompt,
    )
    from api.structure.claude_client import call_claude_structured

    user_prompt = _build_briefing_user_prompt(query, facts_text, total_facts)
    return call_claude_structured(
        BRIEFING_SYSTEM_PROMPT, user_prompt, max_tokens=600,
    )


def _has_korean(text: str) -> bool:
    """True iff `text` contains at least one hangul character (rough
    check that the persona / language instruction took)."""
    for ch in text or "":
        # Hangul syllables block.
        if "가" <= ch <= "힣":
            return True
    return False


def test_briefing_live_returns_grounded_overview():
    """The happy path: 3 verified facts → a Korean 개관 + cited uids."""
    facts_text = _facts_block()
    out = _call_briefing_llm("선거관리위원회", facts_text, 3)

    # JSON contract — keys present.
    assert "briefing" in out, f"missing 'briefing' key: {out}"
    assert "cited_fact_uids" in out, f"missing 'cited_fact_uids' key: {out}"
    assert "grounded" in out, f"missing 'grounded' key: {out}"

    # Grounding — at least one in-set uid was cited.
    cited = out["cited_fact_uids"] or []
    candidates = {"fact-A", "fact-B", "fact-C"}
    grounded_uids = [uid for uid in cited if uid in candidates]
    assert grounded_uids, (
        f"LLM cited nothing from the input set "
        f"(cited={cited}, candidates={candidates})"
    )

    # Persona — Korean, non-empty.
    briefing = (out.get("briefing") or "").strip()
    assert briefing, f"briefing text empty: {out}"
    assert _has_korean(briefing), f"briefing not in Korean: {briefing!r}"

    # Print the verbatim payload so the smoke result can be pasted into
    # the PR body per PO directive ("response 텍스트 sample (verbatim)").
    print("\n[BRIEFING SMOKE 1 / 선거관리위원회]")
    print(json.dumps(out, ensure_ascii=False, indent=2))


def test_briefing_live_second_query_summarises_different_entity():
    """Run a second, semantically different query so we don't trip on a
    one-shot lucky pass. 'A2 우유' with its own fact set."""
    facts_text = "\n".join([
        "[fact-X] A2 우유 포함 A2 베타카제인",
        "[fact-Y] A2 우유 결여 A1 베타카제인",
        "[fact-Z] A2 우유 가격 4500원/L",
    ])
    out = _call_briefing_llm("A2 우유", facts_text, 3)

    cited = out.get("cited_fact_uids") or []
    candidates = {"fact-X", "fact-Y", "fact-Z"}
    assert any(uid in candidates for uid in cited), (
        f"no cited uid from input set (cited={cited})"
    )
    briefing = (out.get("briefing") or "").strip()
    assert briefing
    assert _has_korean(briefing)

    print("\n[BRIEFING SMOKE 2 / A2 우유]")
    print(json.dumps(out, ensure_ascii=False, indent=2))


def test_briefing_live_handles_single_fact():
    """Edge case: a 1-fact set still produces a grounded overview (not
    a refusal). The LLM should pick the obvious uid and write one
    sentence."""
    facts_text = "[fact-ONE] 한국은행 발표함 기준금리 동결 결정"
    out = _call_briefing_llm("한국은행", facts_text, 1)

    cited = out.get("cited_fact_uids") or []
    assert "fact-ONE" in cited, f"LLM did not cite the single input fact: {cited}"
    briefing = (out.get("briefing") or "").strip()
    assert briefing
    assert _has_korean(briefing)

    print("\n[BRIEFING SMOKE 3 / 한국은행]")
    print(json.dumps(out, ensure_ascii=False, indent=2))
