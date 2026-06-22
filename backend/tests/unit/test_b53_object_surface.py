"""B-53 regression: pin the prompt rule that keeps fact-text in the
source language so a future refactor can't silently drop it.

The behavior under test is the decomposer LLM's output — exercised by
manual smoke (PO captures a Korean article and confirms object_value
stays Korean). This file's job is narrower: lock the prompt CONTENT
so we don't lose the rule the LLM is following.

Live diagnosis when this PR opened (origin/main @ 4604182):
    66 facts in `lucid_facts`
    16 had a Korean claim with an ASCII-only object_value
       → e.g. "5억5천556만주" claim, "75 billion USD" object_value
    → rule was missing from the SYSTEM_PROMPT; LLM defaulted to
      English normalization for numbers / units / idioms.

This module asserts the rule now lives in `SYSTEM_PROMPT` and is
specific enough (mentions object_value + source language + the
predicate exception) that a casual edit can't silently neutralize
it.
"""
from __future__ import annotations

from api.structure.prompts import SYSTEM_PROMPT


def test_step_2b_header_present():
    """The B-53 step is anchored in the prompt outline so the LLM
    sees it next to the existing B-52 (Step 2a) rule."""
    assert "Step 2b." in SYSTEM_PROMPT
    assert "B-53" in SYSTEM_PROMPT


def test_object_value_must_stay_in_source_language():
    """The exact pivot — `object_value` is named in the source-language
    rule. Without this token a refactor could rephrase the step into
    a generic "preserve original phrasing" line and lose the bite
    that fixes the 16/66 mismatch the live diagnosis surfaced."""
    assert "object_value" in SYSTEM_PROMPT
    # The rule has to mention BOTH that object_value lives in the
    # source language AND that translating numbers / units is the
    # specific mistake to avoid.
    assert "source language" in SYSTEM_PROMPT.lower()
    # Pin the "do NOT translate" guidance — it's the visible diff
    # between the prompt before and after this PR.
    assert "NOT translate" in SYSTEM_PROMPT or "not translate" in SYSTEM_PROMPT.lower()


def test_predicate_is_source_language_verbatim():
    """feat/spo-decide-payload-wire (PO 2026-06-23): the prior B-53
    'predicate stays in English snake_case regardless of source
    language' exception is RETIRED. PO directive now: predicate must
    be in the source language as a verb phrase, mirroring claim and
    object_value. The Decide UI surfaces source-language predicates
    directly; the predicate-mapper still computes a canonical English
    code via `predicate_label` for graph queries.

    This test pins the new rule: the prompt must mention predicate +
    source-language verb-phrase mandate (한국어 기사 → 한국어 동사구,
    영어 기사 → 영어).
    """
    lower = SYSTEM_PROMPT.lower()
    assert "predicate" in lower
    # The new clause uses Korean verb-phrase examples that survive any
    # line wrap. Pin at least two of the canonical exemplar verbs.
    assert "발표했다" in SYSTEM_PROMPT
    assert "동사구" in SYSTEM_PROMPT


def test_step_2b_includes_concrete_korean_negative_example():
    """The Step 2b block must show the canonical mistake — a Korean
    source mapped to `75 billion USD` (or similar) — so the LLM has
    a worked example. Without that the rule reads as abstract and
    LLM defaults reassert themselves."""
    # The example we wrote uses this exact pair; the test pins it
    # so a future cleanup doesn't paraphrase it into uselessness.
    assert "75 billion USD" in SYSTEM_PROMPT
    assert "750억달러" in SYSTEM_PROMPT


def test_step_2a_b52_rule_still_present_no_regression():
    """The B-53 work must NOT have clobbered B-52's entity-name rule
    while inserting Step 2b. Pin both anchors so a future merge
    can't accidentally collapse them."""
    assert "Step 2a." in SYSTEM_PROMPT
    assert "B-52" in SYSTEM_PROMPT
    # B-52's anchor noun is `aliases` (the storage of the surface form).
    assert "aliases" in SYSTEM_PROMPT


def test_step_2b_appears_before_step_3():
    """Order matters — the rule must land before Step 3 (fact
    decomposition) so the LLM has read it by the time it emits
    object_value."""
    step_2b_idx = SYSTEM_PROMPT.find("Step 2b.")
    step_3_idx = SYSTEM_PROMPT.find("Step 3.")
    assert step_2b_idx >= 0
    assert step_3_idx > step_2b_idx
