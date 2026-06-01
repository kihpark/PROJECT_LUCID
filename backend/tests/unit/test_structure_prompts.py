"""Unit: structure/prompts.py invariants."""
from __future__ import annotations

from api.structure.prompts import (
    FEW_SHOT_EXAMPLES,
    NEGATION_TOKENS_EN,
    NEGATION_TOKENS_KO,
    SYSTEM_PROMPT,
    build_user_message,
)


def test_system_prompt_contains_13_class_ontology():
    """All 13 concrete Object classes named in the ontology block."""
    classes = (
        "concept", "person", "organization", "service", "product",
        "place", "knowledge", "event", "procedure", "task",
        "metric", "resource", "problem",
    )
    for c in classes:
        assert c in SYSTEM_PROMPT, f"missing class in prompt: {c}"


def test_system_prompt_lists_all_16_link_types():
    """5 + 4 + 7 link types are documented."""
    fact_object = ("asserts_property", "describes_state", "addresses", "uses", "involves")
    object_object = ("part_of", "instance_of", "located_in", "has_role")
    fact_fact = (
        "supports", "contradicts", "example_of", "derived_from",
        "interprets", "supersedes", "negates",
    )
    for link in (*fact_object, *object_object, *fact_fact):
        assert link in SYSTEM_PROMPT, f"missing link in prompt: {link}"


def test_system_prompt_documents_dcr001_negation_step():
    """7-step algorithm calls out negation detection at step 4."""
    assert "Step 4" in SYSTEM_PROMPT
    assert "NEGATION DETECTION" in SYSTEM_PROMPT
    assert "negation_flag" in SYSTEM_PROMPT
    assert "negation_scope" in SYSTEM_PROMPT
    assert "full" in SYSTEM_PROMPT  # scope value
    assert "partial" in SYSTEM_PROMPT
    assert "negation_ambiguous" in SYSTEM_PROMPT


def test_system_prompt_explicitly_bans_retired_fields():
    """valid_until / is_stale / stale_at must never be emitted."""
    assert "valid_until" in SYSTEM_PROMPT  # appears in the ban line
    assert "is_stale" in SYSTEM_PROMPT
    assert "stale_at" in SYSTEM_PROMPT
    assert "DR-053" in SYSTEM_PROMPT


def test_negation_token_lists_nonempty_both_languages():
    assert len(NEGATION_TOKENS_KO) >= 8
    assert len(NEGATION_TOKENS_EN) >= 8
    assert "않다" in NEGATION_TOKENS_KO
    assert "not" in NEGATION_TOKENS_EN


def test_few_shot_examples_cover_three_cases():
    """Korean+English compound, partial negation, opinion failure."""
    assert len(FEW_SHOT_EXAMPLES) >= 3
    # Example 2 should have partial negation
    second = FEW_SHOT_EXAMPLES[1]["output"]
    fact = second["facts"][0]
    assert fact["negation_flag"] is True
    assert fact["negation_scope"] == "partial"
    # Example 3 should be a failure case
    third = FEW_SHOT_EXAMPLES[2]["output"]
    assert third["extraction_status"] == "no_facts_found"
    assert third["failure_reason"] == "opinion_content"


def test_build_user_message_includes_metadata_and_text():
    msg = build_user_message("hello world", {"source_url": "https://x.com", "captured_from": "chrome_ext"})
    assert "https://x.com" in msg
    assert "chrome_ext" in msg
    assert "hello world" in msg
    assert "JSON" in msg  # response format reminder
