"""B-62-fix-v3-general unit tests for `brand_resolver.resolve_korean_brand`.

The brand resolver is the narrow brands-only exception layer that
maps Korean transliterations of international brands (스페이스X) to
the canonical English form (SpaceX). It is INTENTIONALLY narrow:
ministries / persons / arbitrary Korean companies are NOT in the
map — they keep their Korean verbatim form.
"""
from __future__ import annotations

from api.structure.brand_resolver import resolve_korean_brand


def test_spacex_korean_transliteration_maps_to_canonical() -> None:
    assert resolve_korean_brand("스페이스X") == "SpaceX"
    assert resolve_korean_brand("스페이스엑스") == "SpaceX"


def test_openai_korean_transliteration_maps_to_canonical() -> None:
    assert resolve_korean_brand("오픈AI") == "OpenAI"
    assert resolve_korean_brand("오픈에이아이") == "OpenAI"


def test_ibm_korean_transliteration_maps_to_canonical() -> None:
    assert resolve_korean_brand("아이비엠") == "IBM"


def test_english_brand_passes_through_as_none() -> None:
    """`SpaceX` itself is not a Korean transliteration — return None
    so the caller's verbatim path runs (SpaceX in English source is
    legitimate, no normalization needed)."""
    assert resolve_korean_brand("SpaceX") is None


def test_arbitrary_korean_company_returns_none() -> None:
    """우리자산운용 is NOT a brand transliteration — it's a Korean
    common-noun company name. Return None so the verbatim rule
    preserves the Korean form."""
    assert resolve_korean_brand("우리자산운용") is None


def test_korean_person_name_returns_none() -> None:
    """안도걸 is a person name — not a brand. Return None."""
    assert resolve_korean_brand("안도걸") is None


def test_korean_ministry_returns_none() -> None:
    """중국 상무부 is a ministry, not a brand. Return None — the
    verbatim rule keeps it Korean."""
    assert resolve_korean_brand("중국 상무부") is None


def test_empty_input_returns_none() -> None:
    assert resolve_korean_brand("") is None
    assert resolve_korean_brand(None) is None
