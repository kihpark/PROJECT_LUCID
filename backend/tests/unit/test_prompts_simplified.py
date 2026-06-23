"""feat/spo-faithful-korean-decomp — pin the simplified prompt.

PO directive (2026-06-23): the 6 prior rounds of "B-62-fix" hardening
flipped the LLM into translation mode and made the cumulative
prompt+schema strict enough that the natural LLM response failed
Pydantic validation (live: facts=0). This test pins the cleanup:

  - No B-62-fix v1/v2/v3 verbatim-mandate strings remain in
    SYSTEM_PROMPT.
  - subject_surface is no longer a mandate (the prompt still mentions
    `subject_surface` as a possible field in the JSON, but never
    "MUST" / "반드시" + verbatim).
  - No KO→canonical-English dictionary-style worked examples
    (Ahn Do-geol / Woori Asset Management / Ministry of Commerce
    of China) survive.
  - The single new "faithful decomposition" rule clause is present.
  - Few-shot count stays at 6 (test_structure_prompts_pr3_2 still
    pins this; the trim happened inside SYSTEM_PROMPT, not in the
    few-shots).
"""
from __future__ import annotations

from api.structure.prompts import FEW_SHOT_EXAMPLES, SYSTEM_PROMPT


def test_b62_fix_strict_clauses_removed() -> None:
    """v1/v2/v3 mandate strings are gone."""
    assert "B-62-fix" not in SYSTEM_PROMPT
    assert "B-62-fix-v2" not in SYSTEM_PROMPT
    assert "B-62-fix-v3" not in SYSTEM_PROMPT


def test_no_subject_surface_verbatim_mandate() -> None:
    """The 'subject_surface must be a verbatim substring' clause is gone.

    The phrase 'verbatim' (which was load-bearing in the v3 mandate)
    should not survive into the simplified prompt body."""
    assert "verbatim" not in SYSTEM_PROMPT.lower()


def test_no_korean_to_english_dictionary_examples() -> None:
    """The KO→canonical-English translation-prescribing examples are
    gone.

    The PR-3-2 worked examples (Ahn Do-geol, Woori Asset Management)
    were the dictionary-style mistakes that taught the LLM to
    translate person/company names. The remaining occurrence of
    'Ministry of Commerce of China' is now ONLY as an example of an
    OPTIONAL `name_en` field — `name` itself stays Korean. That's
    the inverted direction (Korean canonical, English aliased), so
    we explicitly assert the new pattern is the dominant form.
    """
    assert "Ahn Do-geol" not in SYSTEM_PROMPT
    assert "Woori Asset Management" not in SYSTEM_PROMPT
    # The new pattern: name stays Korean, name_en is the English
    # canonical (optional). The literal string '"name":"중국 상무부"'
    # is in the simplified example.
    assert '"name":"중국 상무부"' in SYSTEM_PROMPT


def test_faithful_decomp_rule_clause_present() -> None:
    """The single replacement rule clause is in the prompt.

    The clause is in Korean (PO's verbatim wording). Token-anchored
    on substrings that survive any line-wrap.
    """
    # The PR's signature header anchor:
    assert "FAITHFUL DECOMPOSITION RULE" in SYSTEM_PROMPT
    # The two operative tokens — '소스 텍스트' and '그대로' — are
    # split across a wrap, but each lives on the file as its own
    # substring; the rule says "respect the source language as-is."
    assert "소스 텍스트" in SYSTEM_PROMPT
    assert "그대로" in SYSTEM_PROMPT
    # The prohibition vocabulary survives line wraps too.
    assert "번역" in SYSTEM_PROMPT
    assert "정규화" in SYSTEM_PROMPT


def test_few_shot_examples_count_unchanged() -> None:
    """v0.2.0 step 1 (fact-claim-layer-v1) appends 3 KO claim few-shots
    on top of the PR-3-2 baseline (6) → 9 total. The new shots teach
    the LLM the Action vs Claim classification and the speaker /
    speech_act / content_claim / stance fields."""
    assert len(FEW_SHOT_EXAMPLES) == 9


def test_prompt_is_meaningfully_shorter() -> None:
    """The simplified prompt should be meaningfully shorter than the
    6th-round version. Hard count: pre-simplification SYSTEM_PROMPT
    was ~14,500 chars. v0.2.0 step 1 (fact-claim-layer-v1) added
    the Step 2c Action vs Claim rule + schema annotation; that
    raises the floor a touch (the rule is ~25 lines / ~1.1KB) but
    the simplification savings still hold. Target: under ~13_000.
    """
    assert len(SYSTEM_PROMPT) < 13_000, (
        f"SYSTEM_PROMPT is {len(SYSTEM_PROMPT)} chars; expected <13000 "
        f"after the simplification + the v0.2.0 Action/Claim rule."
    )
