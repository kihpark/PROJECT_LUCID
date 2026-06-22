"""feat/spo-decide-payload-wire — live Claude predicate smoke.

PO directive (2026-06-23): the prompt now mandates source-language
verb phrases for `predicate`. This smoke catches the regression where
Claude reverts to English snake_case predicates on Korean text (the
exact PR-3 bug).

Gated by LUCID_LIVE_LLM_SMOKE=1 so CI doesn't spend ~$0.01 per run.
PO runs it manually before merging this PR.

Two cases:

  1. Korean article → NO snake_case English predicates. At least one
     fact must carry a predicate that contains Hangul.
  2. English article → English predicates expected. Korean predicates
     NOT (control — proves the rule is symmetric, not Korean-biased).
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
    "대한적십자사는 22일 새 회장을 선출했다고 발표했다. 이번 선출은 "
    "정관 개정 이후 처음으로 회원 직접 투표 방식으로 진행되었다."
)

_ENGLISH_TEST_ARTICLE = (
    "On June 22, 2026, OpenAI announced GPT-5, claiming significant "
    "improvements in reasoning and tool use. The product launches "
    "to enterprise customers next month."
)


def _has_hangul(s: str) -> bool:
    return bool(re.search(r"[가-힯]", s))


def _is_snake_case_english(s: str) -> bool:
    """A predicate is snake_case-English when it has ASCII letters and
    underscores and NO Hangul. Single English verb words (`elected`,
    `announced`) count too — they are still English-on-Korean if the
    source is Korean."""
    if _has_hangul(s):
        return False
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9_]*$", s.strip()))


def test_korean_article_yields_korean_predicates() -> None:
    """Korean article → at least one fact, no snake_case English
    predicates. The prompt mandates source-language verb phrases.
    """
    from api.structure.decomposer import decompose

    result = decompose(_KOREAN_TEST_ARTICLE)

    assert result.extraction_status == "success", (
        f"expected success, got {result.extraction_status} "
        f"(failure_reason={result.failure_reason!r})"
    )
    assert len(result.facts) >= 1

    # CONTRACT: every predicate on a Korean fact must contain Hangul
    # (the predicate is in source language). The prior bug was the LLM
    # emitting `elected_president` on a Korean claim.
    english_predicates = [
        f.predicate for f in result.facts
        if _is_snake_case_english(f.predicate)
    ]
    assert not english_predicates, (
        f"Found {len(english_predicates)} snake_case-English predicates "
        f"on Korean source — prompt mandate violated. Examples: "
        f"{english_predicates[:5]}"
    )
    # And at least one predicate IS Korean.
    korean_predicates = [
        f.predicate for f in result.facts if _has_hangul(f.predicate)
    ]
    assert korean_predicates, (
        f"Expected at least one Korean predicate, got "
        f"{[f.predicate for f in result.facts]}"
    )


def test_english_article_yields_english_predicates() -> None:
    """English article → English predicates. Korean predicates would
    be a SYMMETRY violation (Korean rule misapplied to English source).
    """
    from api.structure.decomposer import decompose

    result = decompose(_ENGLISH_TEST_ARTICLE)

    assert result.extraction_status == "success"
    assert len(result.facts) >= 1

    # CONTRACT: on English source, predicates must NOT carry Hangul.
    korean_predicates = [
        f.predicate for f in result.facts if _has_hangul(f.predicate)
    ]
    assert not korean_predicates, (
        f"Found Korean predicates on English source — symmetry "
        f"violation: {korean_predicates}"
    )
