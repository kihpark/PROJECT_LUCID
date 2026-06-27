"""M3-1 Stage 1 LLM gate — integration over the full dry-run flow.

★ The 남한/국내 false-positive case lives here: a synthetic proposal
set that includes the FP pair is fed through the gate (with a mocked
Claude that returns 'no' on the FP pair), and we assert the bucketing
output drops it from the 병합 권장 list.

The mock is structured so each Claude call observes the actual prompt
the gate built — the test verifies (1) the right number of LLM calls,
(2) the verdict bucketing is correct per proposal, and (3) the
false-positive (남한/국내) is explicitly tagged as 'no'.

These are integration tests (they touch the dry-run CLI's bucketing
helper + the discovery output shape) but they DO NOT hit ES or any
real network — the ES client and the anthropic SDK are both mocked.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from api.models.canonical import MergeProposal
from api.ops.canonical_dryrun import (
    _gate_all_proposals,
    _summarize_buckets,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _proposal(
    target: str,
    other: str,
    primary: str,
    *,
    aliases: list[str] | None = None,
    entity_type: str = "organization",
) -> MergeProposal:
    return MergeProposal(
        target_canonical_uid=target,
        members=[target, other],
        primary_label=primary,
        aliases=aliases or [],
        entity_type=entity_type,
        confidence="deterministic",
        fact_provenance={},
        reason=f"shared normalized surface for {primary}",
    )


class _FakeES:
    """ES stub that maps uid -> doc + uid -> facts. Just enough to feed
    the dry-run helpers without a live ES cluster."""

    def __init__(self, docs: dict[str, dict[str, Any]],
                 facts: dict[str, list[str]]):
        self._docs = docs
        self._facts = facts

    def get(self, *, index: str, id: str) -> dict[str, Any]:
        if id not in self._docs:
            raise KeyError(id)
        return {"_source": self._docs[id]}

    def search(self, *, index, query=None, size=None, _source=None):
        # Identify the queried member_uid from the term filter.
        try:
            should = query["bool"]["filter"][1]["bool"]["should"]
            uid = should[0]["term"]["subject_uid"]
        except Exception:
            uid = None
        claims = self._facts.get(uid, [])[:size or 3]
        return {"hits": {"hits": [{"_source": {"claim": c}} for c in claims]}}


def _build_response(verdict: str, reason: str) -> MagicMock:
    """Wrap a JSON envelope in a MagicMock that looks like an anthropic
    messages.create return value."""
    resp = MagicMock()
    block = MagicMock()
    block.text = f'{{"verdict": "{verdict}", "reason": "{reason}"}}'
    resp.content = [block]
    return resp


# ---------------------------------------------------------------------------
# 1. Bucketing across a mixed proposal set
# ---------------------------------------------------------------------------

def test_gate_buckets_mixed_proposal_set(monkeypatch):
    """A 3-proposal slate covering all three verdict buckets:

      A. 애플 / Apple Inc.        -> yes        (병합 권장)
      B. 남한 / 국내              -> no         (병합 거부 — FP 차단)
      C. 한국은행 / 한은          -> yes        (병합 권장)

    Mocked Claude answers each in turn; the bucketing must reflect 2x
    yes + 1x no.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    proposals = [
        _proposal("u-apple-kr", "u-apple-en", "애플",
                  aliases=["Apple Inc."]),
        _proposal("u-namhan", "u-gukne", "남한",
                  aliases=["국내"], entity_type="place"),
        _proposal("u-bok-long", "u-han", "한국은행",
                  aliases=["한은"]),
    ]

    docs = {
        "u-apple-kr": {"primary_label": "애플", "entity_type": "organization"},
        "u-apple-en": {"primary_label": "Apple Inc.",
                       "entity_type": "organization"},
        "u-namhan": {"primary_label": "남한", "name_en": "South Korea",
                     "entity_type": "place"},
        "u-gukne": {"primary_label": "국내", "name_en": "South Korea",
                    "entity_type": "place"},
        "u-bok-long": {"primary_label": "한국은행",
                       "entity_type": "organization"},
        "u-han": {"primary_label": "한은",
                  "entity_type": "organization"},
    }
    facts = {
        "u-apple-kr": ["애플은 아이폰을 만든다"],
        "u-apple-en": ["Apple produces iPhones"],
        "u-namhan": ["남한 국방비 50조"],
        "u-gukne": ["국내 가격 인상"],
        "u-bok-long": ["한국은행 기준금리 동결"],
        "u-han": ["한은이 금리를 결정"],
    }
    es = _FakeES(docs, facts)

    fake_client = MagicMock()
    # The gate is called once per proposal, in order: apple, namhan, bok.
    fake_client.messages.create.side_effect = [
        _build_response("yes",
            "애플과 Apple Inc.는 동일한 회사"),
        _build_response("no",
            "국내는 상대 개념이라 남한과 다른 지시 대상"),
        _build_response("yes",
            "한국은행과 한은은 동일 기관의 정식/약칭"),
    ]

    with patch("anthropic.Anthropic", return_value=fake_client):
        verdicts = asyncio.run(_gate_all_proposals(
            es, proposals, ks_id="ks-test",
        ))

    assert len(verdicts) == 3
    assert verdicts[0][0] == "yes"
    assert verdicts[1][0] == "no"
    assert verdicts[2][0] == "yes"

    # Bucket summary string lists every verdict bucket explicitly.
    summary = _summarize_buckets(proposals, verdicts)
    assert "병합 권장: 2" in summary
    assert "병합 거부 (false-positive 차단): 1" in summary
    assert "PO 검토 필요: 0" in summary

    # Explicit FP block: the 남한/국내 proposal's verdict is 'no' and
    # the reason mentions 국내 / 상대.
    fp_verdict, fp_reason = verdicts[1]
    assert fp_verdict == "no"
    assert "국내" in fp_reason or "상대" in fp_reason


# ---------------------------------------------------------------------------
# 2. False-positive isolation: a slate containing ONLY the 남한/국내 case
# ---------------------------------------------------------------------------

def test_gate_blocks_namhan_gukne_false_positive(monkeypatch):
    """Explicit lock for the PO-cited false-positive: a single
    proposal that the deterministic key surfaced (shared name_en =
    'South Korea') gets dropped by the gate."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    proposals = [
        _proposal("u-namhan", "u-gukne", "남한",
                  aliases=["국내"], entity_type="place"),
    ]
    docs = {
        "u-namhan": {"primary_label": "남한", "name_en": "South Korea",
                     "entity_type": "place"},
        "u-gukne": {"primary_label": "국내", "name_en": "South Korea",
                    "entity_type": "place"},
    }
    facts = {
        "u-namhan": ["남한 인구 5천만"],
        "u-gukne": ["국내 가격 인상"],
    }
    es = _FakeES(docs, facts)

    fake_client = MagicMock()
    fake_client.messages.create.return_value = _build_response(
        "no",
        "남한은 국가 고유 지시이고 국내는 상대적 개념이라 다른 엔티티",
    )

    with patch("anthropic.Anthropic", return_value=fake_client):
        verdicts = asyncio.run(_gate_all_proposals(
            es, proposals, ks_id="ks-test",
        ))

    assert verdicts == [(
        "no",
        "남한은 국가 고유 지시이고 국내는 상대적 개념이라 다른 엔티티",
    )]
    summary = _summarize_buckets(proposals, verdicts)
    assert "병합 거부 (false-positive 차단): 1" in summary
    assert "병합 권장: 0" in summary
