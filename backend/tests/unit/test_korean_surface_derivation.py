"""B-62-fix-v3 unit tests for `derive_korean_surface_from_claim`.

The function is the load-bearing piece of the Mode A defense
(processor.py `_match_object` calls it when raw_surface is missing
or English and the claim contains Hangul). These tests lock the
five invariants:

  1. Direct dict match: known English org name + Korean claim →
     return the Korean form.
  2. Compound English name (e.g. "Ministry of Finance of China"):
     substring scan finds the longest Korean match in the claim.
  3. English claim → return None (no Korean to recover).
  4. Brand-shaped llm_name (SpaceX) → return None (defer to English
     brand canonical even if a Korean substring exists).
  5. Multi-word English brand NOT in dict (RedCat Holdings) → return
     None (the dictionary is curated; unknown English names never
     get korean-ified).

These eight tests cover the call-graph branches: the four returns
(None × 4 + Korean × 1) and the longest-match selection.
"""
from __future__ import annotations

from api.structure.surface_extractor import (
    _has_hangul,
    derive_korean_surface_from_claim,
)


def test_korean_claim_with_ministry_of_commerce_derives_korean() -> None:
    """Direct dict hit: 'Ministry of Commerce of China' maps to
    '중국 상무부' and that form is in the Korean claim."""
    assert derive_korean_surface_from_claim(
        claim="중국 상무부는 새로운 수출통제 조치를 발표했다.",
        llm_name_en="Ministry of Commerce of China",
        claim_lang="ko",
    ) == "중국 상무부"


def test_korean_claim_with_ministry_of_finance_derives_korean() -> None:
    """Direct dict hit for finance ministry variant."""
    assert derive_korean_surface_from_claim(
        claim="중국 재정부는 새 정책을 발표했다.",
        llm_name_en="Ministry of Finance of China",
        claim_lang="ko",
    ) == "중국 재정부"


def test_export_control_policy_noun_derives_korean() -> None:
    """Policy noun (export control → 수출통제) is supported."""
    assert derive_korean_surface_from_claim(
        claim="수출통제가 강화되었다고 발표됐다.",
        llm_name_en="export control",
        claim_lang="ko",
    ) == "수출통제"


def test_english_claim_returns_none() -> None:
    """English claim has no Hangul — nothing to recover. Return None
    so the original English flow runs unchanged."""
    assert derive_korean_surface_from_claim(
        claim="China's Ministry of Commerce announced new measures.",
        llm_name_en="Ministry of Commerce",
        claim_lang="en",
    ) is None


def test_brand_shaped_llm_name_returns_none() -> None:
    """Brand-shaped (single-token Latin <=16 chars) llm_name short-
    circuits — defer to English brand canonical even on Korean
    captures."""
    assert derive_korean_surface_from_claim(
        claim="스페이스X 주식이 상장됐다.",
        llm_name_en="SpaceX",
        claim_lang="ko",
    ) is None


def test_redcat_holdings_multiword_english_returns_none() -> None:
    """RedCat Holdings is NOT in the dictionary. Even on a synthetic
    Korean claim, derivation returns None — RedCat stays English."""
    assert derive_korean_surface_from_claim(
        claim="미국 RedCat Holdings가 새 드론을 발표했다.",
        llm_name_en="RedCat Holdings",
        claim_lang="ko",
    ) is None


def test_missing_llm_name_en_returns_none() -> None:
    """No llm_name_en (None or empty string) → cannot look up → None."""
    assert derive_korean_surface_from_claim(
        claim="중국 상무부는 발표했다.",
        llm_name_en=None,
        claim_lang="ko",
    ) is None
    assert derive_korean_surface_from_claim(
        claim="중국 상무부는 발표했다.",
        llm_name_en="",
        claim_lang="ko",
    ) is None


def test_no_hangul_in_claim_returns_none() -> None:
    """Claim with no Hangul → None, regardless of claim_lang."""
    assert derive_korean_surface_from_claim(
        claim="The Ministry of Commerce announced...",
        llm_name_en="Ministry of Commerce",
        claim_lang=None,
    ) is None


def test_longest_korean_match_wins() -> None:
    """Both 'Ministry of Commerce' (상무부) and 'Ministry of Commerce
    of China' (중국 상무부) are dict keys. On a claim containing the
    full '중국 상무부' form, the longer (more specific) Korean form
    wins."""
    assert derive_korean_surface_from_claim(
        claim="중국 상무부 관계자는 발표했다.",
        llm_name_en="Ministry of Commerce of China",
        claim_lang="ko",
    ) == "중국 상무부"


def test_has_hangul_basic() -> None:
    """Sanity check for the Hangul detector used by the matcher gate."""
    assert _has_hangul("중국 상무부") is True
    assert _has_hangul("Ministry of Commerce") is False
    assert _has_hangul("") is False
    assert _has_hangul(None) is False
    assert _has_hangul("Ministry of 무역 dept") is True
