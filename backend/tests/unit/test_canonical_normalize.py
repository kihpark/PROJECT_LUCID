"""M3-1 canonical-layer unit tests — normalization + key + LLM stub.

These tests lock the deterministic rules that drive the entire
discovery / cluster / dry-run pipeline. They never hit ES or Anthropic
(the LLM helper degrades to ('uncertain', ...) with no API key, which
is the conservative default after the Stage 1 LLM gate landed).
"""
from __future__ import annotations

import asyncio

from api.services.canonical_mapping import (
    deterministic_canonical_key,
    llm_canonical_match,
    normalize_label,
)


# ---------------------------------------------------------------------------
# normalize_label
# ---------------------------------------------------------------------------

def test_normalize_collapses_korean_whitespace():
    """★ The PO-KS data shows '한국은행' vs '한국 은행' = same entity.

    Same for the live cluster 'MP 머티리얼즈' vs 'MP머티리얼스'.
    Whitespace collapse must hash them to identical keys.
    """
    assert normalize_label("한국은행") == normalize_label("한국 은행")
    assert normalize_label("MP 머티리얼즈") == normalize_label("MP머티리얼즈")


def test_normalize_lowercase_and_nfkc():
    """Lowercase + NFKC handles fullwidth/halfwidth + ASCII case noise.

    The discovery surfaced 'Bank of Korea' / 'BANK OF KOREA' as well as
    fullwidth digit drift that pops up in copy-pasted Korean text.
    """
    assert normalize_label("Bank of Korea") == normalize_label("BANK OF KOREA")
    assert normalize_label("ＭＰMaterials") == normalize_label("MPMaterials")


def test_normalize_empty_and_none():
    assert normalize_label(None) == ""
    assert normalize_label("") == ""
    assert normalize_label("   ") == ""


def test_normalize_preserves_hangul_codepoints():
    """The fold is case+whitespace+NFKC only — Hangul characters must
    survive unchanged so '국방부' and '국방부' (two NFKC-equivalent
    forms) compare equal while staying recognisable in logs."""
    out = normalize_label("국방부")
    assert "국방부" in out


# ---------------------------------------------------------------------------
# deterministic_canonical_key
# ---------------------------------------------------------------------------

def test_canonical_key_emits_one_per_unique_surface():
    """A single entity contributes one key per unique surface form."""
    keys = deterministic_canonical_key(
        "organization",
        "MP 머티리얼즈",
        "MP Materials",
        aliases=["MP Materials"],  # duplicate of name_en — must collapse
    )
    assert ("organization", "mp머티리얼즈") in keys
    assert ("organization", "mpmaterials") in keys
    # Duplicates from aliases collapse:
    assert len(keys) == len(set(keys))


def test_canonical_key_includes_type_so_classes_dont_cross():
    """A 'concept' named 'X' and a 'person' named 'X' MUST NOT share a key."""
    ka = deterministic_canonical_key("concept", "X")
    kb = deterministic_canonical_key("person", "X")
    assert set(ka).isdisjoint(set(kb))


def test_canonical_key_empty_inputs_short_circuit():
    assert deterministic_canonical_key("", "X") == []
    assert deterministic_canonical_key(None, "X") == []
    assert deterministic_canonical_key("organization", "", "") == []


def test_canonical_key_collides_for_kr_en_shared_alias():
    """★ This is the PO-KS reality:

    'MP 머티리얼즈' and 'MP머티리얼스' have DIFFERENT primary surfaces
    but BOTH carry name_en='MP Materials'. The deterministic key must
    collide on the english surface so the cluster forms."""
    ka = deterministic_canonical_key("organization", "MP 머티리얼즈", "MP Materials")
    kb = deterministic_canonical_key("organization", "MP머티리얼스", "MP Materials")
    assert set(ka) & set(kb)  # non-empty intersection
    assert ("organization", "mpmaterials") in ka
    assert ("organization", "mpmaterials") in kb


# ---------------------------------------------------------------------------
# llm_canonical_match — Stage 1 LLM gate (conservative defaults)
# ---------------------------------------------------------------------------

def test_llm_returns_uncertain_when_no_api_key(monkeypatch):
    """Cost guard: no ANTHROPIC_API_KEY -> never call. We default to
    ('uncertain', ...) (under-merge) so CI without secrets cannot
    silently merge — same conservative posture as the old bool stub,
    but now carrying the 3-way verdict the gate needs."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    verdict, reason = asyncio.run(llm_canonical_match(
        {"primary_label": "Bank of Korea", "entity_type": "organization"},
        {"primary_label": "한국은행", "entity_type": "organization"},
        ["BOK sets rates"],
        ["한국은행 기준금리 인상"],
    ))
    assert verdict == "uncertain"
    assert "no api key" in reason
