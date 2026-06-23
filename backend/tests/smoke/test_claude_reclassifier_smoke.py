"""Live Claude smoke for entity_reclassifier.classify_by_llm.

Pins the LLM-side contract: when given a Korean person name, Claude
must return 'person'; when given a Korean ministry, 'organization'.
Without this, a future prompt edit could silently degrade the
backfill to 'other' (no-op) without any other test catching it.

Gated by LUCID_LIVE_LLM_SMOKE=1 to keep CI from spending API credits.
PO runs manually before merging.
"""
from __future__ import annotations

import os

import pytest

from api.structure.entity_reclassifier import classify_by_llm

LIVE = os.getenv("LUCID_LIVE_LLM_SMOKE") == "1"
pytestmark = pytest.mark.skipif(
    not LIVE, reason="set LUCID_LIVE_LLM_SMOKE=1 to run live"
)


def test_korean_person_classifies_as_person() -> None:
    """위철환 is a Korean 3-syllable proper name; Claude must call
    it 'person'. The heuristic would already catch this, but the LLM
    contract must agree — otherwise the foreign-brand fallback path
    would be wrong too."""
    result = classify_by_llm("위철환")
    assert result == "person", (
        f"expected 'person', got {result!r} (regression in prompt contract)"
    )


def test_korean_ministry_classifies_as_organization() -> None:
    """중국 상무부 is the China Ministry of Commerce; Claude must
    call it 'organization'."""
    result = classify_by_llm("중국 상무부")
    assert result == "organization", (
        f"expected 'organization', got {result!r}"
    )


def test_foreign_brand_classifies_as_organization() -> None:
    """록히드마틴 (Lockheed Martin) — foreign company with no Korean
    org suffix. This is the canonical LLM-fallback path: heuristic
    abstains, LLM must catch."""
    result = classify_by_llm("록히드마틴")
    assert result == "organization", (
        f"expected 'organization', got {result!r}"
    )
