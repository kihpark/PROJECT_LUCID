"""M3-1 Stage 1 LLM gate — unit tests.

These tests lock the conservative-default contract of the LLM gate:
no API key -> 'uncertain', and the dry-run / apply guard rails on
canonical_merge.apply_merge stay enforced regardless of verdict.

Every test mocks the Claude call (no network), so the suite runs in
the unit harness with no secrets. The fact-set filter helper is also
exercised here so future callers (an apply-staging pipeline) can rely
on a single source of truth for "given a proposal + verdict, keep or
drop".
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from api.models.canonical import MergeProposal
from api.ops.canonical_merge import apply_merge
from api.services.canonical_mapping import llm_canonical_match


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _proposal(uid_a: str = "u-a", uid_b: str = "u-b") -> MergeProposal:
    """Minimal MergeProposal fixture — enough fields to satisfy the
    pydantic model, no surface noise to obscure the gate logic."""
    return MergeProposal(
        target_canonical_uid=uid_a,
        members=[uid_a, uid_b],
        primary_label="Test Label",
        aliases=["Test Alias"],
        entity_type="organization",
        confidence="deterministic",
        fact_provenance={"f-1": uid_a},
        reason="test fixture",
    )


def _filter_by_verdict(
    proposal: MergeProposal,
    verdict: str,
) -> MergeProposal | None:
    """Reference filter for the gate — keep on 'yes', drop on 'no' /
    'uncertain'. The dry-run CLI uses the same rule when bucketing;
    pulling it into a helper here lets future callers (apply staging,
    UI list) share the policy.
    """
    return proposal if verdict == "yes" else None


def _mock_claude_response(text: str) -> MagicMock:
    """Build a MagicMock that walks like an anthropic message response."""
    resp = MagicMock()
    block = MagicMock()
    block.text = text
    resp.content = [block]
    return resp


# ---------------------------------------------------------------------------
# 1. LLM yes -> proposal kept
# ---------------------------------------------------------------------------

def test_llm_yes_keeps_proposal(monkeypatch):
    """When the gate returns 'yes', the reference filter keeps the
    proposal — i.e. the apply-staging pipeline would proceed with it.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _mock_claude_response(
        '{"verdict": "yes", "reason": "same firm — 애플 = Apple"}'
    )
    with patch("anthropic.Anthropic", return_value=fake_client):
        verdict, reason = asyncio.run(llm_canonical_match(
            {"primary_label": "애플", "entity_type": "organization"},
            {"primary_label": "Apple Inc.", "entity_type": "organization"},
            ["애플 매출 100조"],
            ["Apple revenue 100T KRW"],
        ))
    assert verdict == "yes"
    assert "same firm" in reason or "Apple" in reason
    kept = _filter_by_verdict(_proposal(), verdict)
    assert kept is not None
    assert kept.target_canonical_uid == "u-a"


# ---------------------------------------------------------------------------
# 2. LLM no -> proposal rejected
# ---------------------------------------------------------------------------

def test_llm_no_rejects_proposal(monkeypatch):
    """The false-positive blocker. Gate returns 'no' on 남한/국내, the
    filter drops the proposal so the apply-staging pipeline never
    proposes the merge."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _mock_claude_response(
        '{"verdict": "no", "reason": "국내는 상대적 개념이라 남한과 동일하지 않다"}'
    )
    with patch("anthropic.Anthropic", return_value=fake_client):
        verdict, reason = asyncio.run(llm_canonical_match(
            {"primary_label": "남한", "name_en": "South Korea",
             "entity_type": "place"},
            {"primary_label": "국내", "name_en": "South Korea",
             "entity_type": "place"},
            ["남한 인구 5천만"],
            ["국내 시장 점유율 30%"],
        ))
    assert verdict == "no"
    assert "남한" in reason or "국내" in reason
    kept = _filter_by_verdict(_proposal(), verdict)
    assert kept is None


# ---------------------------------------------------------------------------
# 3. LLM uncertain -> proposal rejected (conservative)
# ---------------------------------------------------------------------------

def test_llm_uncertain_rejects_proposal(monkeypatch):
    """Cost guard: when the gate is unsure, we DO NOT auto-merge. The
    proposal is dropped from the apply pipeline; the PO can still see
    it in the dry-run report under the 'PO 검토 필요' bucket."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _mock_claude_response(
        '{"verdict": "uncertain", "reason": "맥락이 부족하여 판단 불가"}'
    )
    with patch("anthropic.Anthropic", return_value=fake_client):
        verdict, reason = asyncio.run(llm_canonical_match(
            {"primary_label": "X", "entity_type": "organization"},
            {"primary_label": "Y", "entity_type": "organization"},
            [],
            [],
        ))
    assert verdict == "uncertain"
    assert "판단" in reason or "맥락" in reason
    kept = _filter_by_verdict(_proposal(), verdict)
    assert kept is None


# ---------------------------------------------------------------------------
# 4. No API key -> uncertain
# ---------------------------------------------------------------------------

def test_no_api_key_returns_uncertain(monkeypatch):
    """The cheap-by-default path: no ANTHROPIC_API_KEY -> never call
    Claude, return ('uncertain', 'no api key — conservative default').
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    verdict, reason = asyncio.run(llm_canonical_match(
        {"primary_label": "한국은행", "entity_type": "organization"},
        {"primary_label": "한은", "entity_type": "organization"},
        ["한국은행 기준금리"],
        ["한은이 금리 결정"],
    ))
    assert verdict == "uncertain"
    assert "no api key" in reason


# ---------------------------------------------------------------------------
# 5. apply_merge(dry_run=False) MUST raise NotImplementedError
# ---------------------------------------------------------------------------

def test_apply_merge_apply_path_raises_not_implemented():
    """The PO-command guard. Even if every other piece is in place,
    apply_merge with dry_run=False MUST raise — the gate is what keeps
    a wrong invocation from landing a write."""
    p = _proposal()
    with pytest.raises(NotImplementedError, match="PO command"):
        apply_merge(client=MagicMock(), proposal=p, dry_run=False)


# ---------------------------------------------------------------------------
# 6. apply_merge(dry_run=True) returns summary without raising
# ---------------------------------------------------------------------------

def test_apply_merge_dry_run_returns_summary():
    """The dry-run path is the safe one: no raise, structured summary
    shape includes the would_merge / would_rewrite counts the CLI
    prints."""
    p = _proposal()
    summary = apply_merge(client=None, proposal=p, dry_run=True)
    assert summary["dry_run"] is True
    assert summary["target_canonical_uid"] == "u-a"
    assert summary["would_merge_n_objects"] == 1  # 2 members -> 1 retired
    assert summary["would_rewrite_n_facts"] == 1
    assert summary["fact_provenance"] == {"f-1": "u-a"}
