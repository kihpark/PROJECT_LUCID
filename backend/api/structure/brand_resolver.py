"""Brand canonical resolver — Korean transliterations of international brands.

PO 2026-06-22 directive (feat/spo-surface-content-language):

Maps known Korean transliterations of international brand names to
their canonical English form. This is INTENTIONALLY narrow: only
entries where the English form is brand-shaped (single-token Latin,
2-16 chars per `_looks_like_brand`). Ministries / persons /
arbitrary companies are NOT in this map — they keep their Korean
verbatim form per the general verbatim-substring rule.

This module is separate from the prior `_KO_EN_ORG_DICT` band-aid by
design. That dictionary tried to translate Korean common nouns
(중국 상무부 ↔ Ministry of Commerce) and policy nouns (수출통제 ↔
export control). This module does ONE thing: recognize when a
Korean transliteration of an international brand has been emitted
and normalize to the canonical English form.

Extend cautiously. If you are uncertain whether something is "a
real international brand with an established English canonical" or
"a Korean common noun the LLM happened to translate", DO NOT add
it — leave it Korean and let the verbatim rule preserve it.
"""
from __future__ import annotations

from api.structure.entity_resolver import _looks_like_brand

# Korean transliteration → English canonical. Curated, brand-shaped
# values only.
_KO_TO_EN_BRAND: dict[str, str] = {
    # Tech / aerospace
    "스페이스X": "SpaceX",
    "스페이스엑스": "SpaceX",
    "오픈AI": "OpenAI",
    "오픈에이아이": "OpenAI",
    "아이비엠": "IBM",
    "엔비디아": "Nvidia",
    "구글": "Google",
    "애플": "Apple",
    "마이크로소프트": "Microsoft",
    "메타": "Meta",
    "테슬라": "Tesla",
    "아마존": "Amazon",
    "트위터": "Twitter",
    "페이스북": "Facebook",
    "인텔": "Intel",
}

# Self-check at import time: every value must satisfy the brand-shape
# constraint. Catches accidental multi-word entries like "Lockheed
# Martin" that should NOT be in this map (multi-word English names
# pass through as verbatim substrings of the source — see
# `surface_extractor.detect_violation`).
_INVALID = [v for v in _KO_TO_EN_BRAND.values() if not _looks_like_brand(v)]
assert not _INVALID, (
    f"brand_resolver: non-brand-shaped values rejected: {_INVALID}. "
    "Each canonical must be a single Latin token, 2-16 chars."
)


def resolve_korean_brand(surface: str | None) -> str | None:
    """If `surface` is a known Korean transliteration of an
    international brand, return the canonical English form. Otherwise
    None.

    The caller is expected to have already stripped trailing Korean
    particles (`strip_korean_particles`), so this is an exact lookup
    on the bare-entity form.
    """
    if not surface:
        return None
    return _KO_TO_EN_BRAND.get(surface.strip())


__all__ = ["resolve_korean_brand"]
