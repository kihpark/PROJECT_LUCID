"""feat/spo-decide-payload-wire — predicate verbatim prompt clause.

PO directive (2026-06-23): the prior B-53 'predicate stays in English
snake_case regardless of source language' exception is retired. The
new rule mandates source-language verb phrases for the predicate to
match claim and object_value (everything stays in source language).

This module pins the new prompt clause:

  1. The new predicate-verbatim clause is present in SYSTEM_PROMPT.
  2. Korean and English exemplar verbs both shown.
  3. The snake_case English warning ('elected_president' /
     'imposed_export_control_on') is explicit so the LLM has a
     concrete anti-example.
"""
from __future__ import annotations

from api.structure.prompts import SYSTEM_PROMPT


def test_predicate_verbatim_clause_present() -> None:
    """The new clause is anchored by a recognisable label."""
    # The PR-3 directive's signature header anchor:
    assert "동사구 그대로" in SYSTEM_PROMPT
    # The replacement rule unconditionally extends Step 2b — pin the
    # token that anchors the source-language scope of predicate.
    assert "predicate" in SYSTEM_PROMPT
    # And the directive is keyed on the source-language label.
    assert "source 언어" in SYSTEM_PROMPT or "source 언어의" in SYSTEM_PROMPT


def test_korean_and_english_examples_both_shown() -> None:
    """Both Korean and English verb-phrase exemplar predicates exist,
    so the LLM has a worked example for each source language."""
    # Korean verb-phrase exemplars (canonical 6 forms shipped by the
    # PR-3 directive — at least three must survive any rewording).
    ko_verbs = ("선출했다", "발표했다", "조달했다", "출신이다", "올렸다", "축소되었다")
    ko_hits = sum(1 for v in ko_verbs if v in SYSTEM_PROMPT)
    assert ko_hits >= 3, (
        f"Expected ≥3 Korean verb-phrase exemplars in prompt, found {ko_hits}"
    )
    # English exemplars — at least two of the canonical set.
    en_verbs = ("elected", "announced", "raised_funding", "is_former_member_of")
    en_hits = sum(1 for v in en_verbs if v in SYSTEM_PROMPT)
    assert en_hits >= 2, (
        f"Expected ≥2 English exemplar predicates in prompt, found {en_hits}"
    )


def test_snake_case_english_warning_present() -> None:
    """The anti-example explicitly calls out snake_case English on
    Korean claims — the canonical PO bug case."""
    # The directive bans snake_case English on Korean claims. Pin the
    # token that survives line-wrap.
    assert "snake_case" in SYSTEM_PROMPT
    # And at least one concrete anti-example so the LLM has a target.
    assert (
        "elected_president" in SYSTEM_PROMPT
        or "imposed_export_control_on" in SYSTEM_PROMPT
        or "announces_export_control" in SYSTEM_PROMPT
    )
    # The 금지 token anchors the prohibition direction.
    assert "금지" in SYSTEM_PROMPT
