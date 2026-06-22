"""B-62-fix-v3 (PO 2026-06-22): code-deterministic Korean surface
derivation from claim text.

The LLM has been told three times via the system prompt to fill
`subject_surface` with the verbatim source-language span. It keeps
defaulting to the English translation or omitting the field entirely
for Korean-government / common-noun entities. Prompt enforcement
has failed (see B62_DEBUG_DISCOVERY.md — measurement, not guess).

This module provides `derive_korean_surface_from_claim` — a
deterministic dictionary + substring scan that, when:
  - the claim text contains Hangul, AND
  - the LLM's emitted name is English non-brand, AND
  - a known Korean equivalent of that English name appears in the
    claim text,
recovers the Korean surface and returns it. The caller (processor.py
`_match_object`) uses it as the surface when the LLM-supplied one is
absent or English.

Brand guard: `_looks_like_brand` from entity_resolver short-circuits
any attempt to korean-ify a real English brand (SpaceX, OpenAI,
RedCat, Lockheed). The dictionary is curated to common
Korean-government / financial / policy nouns only — never
companies, products, or generic adjectives.

No LLM call. No fuzzy match. No regex magic. Conservative by design.
"""
from __future__ import annotations

import logging
import re
from typing import Final

from api.structure.entity_resolver import _looks_like_brand

logger = logging.getLogger("lucid.structure.surface_extractor")

# Known English↔Korean canonical pairs for entities the LLM frequently
# translates instead of preserving in source-language form.
#
# Curation rules:
#  - Government / ministerial / official-body names.
#  - Policy nouns the LLM reliably translates (export control, base
#    rate, etc.).
#  - NOT companies / brands — those go through `_looks_like_brand`.
#  - NOT regions / generic adjectives — those are not entities.
#
# When the LLM emits a key on the LEFT and the claim contains the
# Korean form on the RIGHT, we substitute. Variants share an entry
# (the longest matching Korean form wins downstream so 중국 상무부
# beats 상무부 when the claim contains both).
_KO_EN_ORG_DICT: Final[dict[str, str]] = {
    # China ministries
    "Ministry of Commerce of China": "중국 상무부",
    "China's Ministry of Commerce": "중국 상무부",
    "Ministry of Commerce": "상무부",
    "Ministry of Finance of China": "중국 재정부",
    "China's Ministry of Finance": "중국 재정부",
    "Ministry of Finance": "재정부",
    "Ministry of Foreign Affairs of China": "중국 외교부",
    "Ministry of Foreign Affairs": "외교부",
    "Ministry of Defense": "국방부",
    "Ministry of National Defense": "국방부",
    "Ministry of Environment": "환경부",
    "Ministry of Justice": "법무부",
    "Ministry of Education": "교육부",
    # Korea-side organs
    "Bank of Korea": "한국은행",
    "Financial Services Commission": "금융위원회",
    "Financial Supervisory Service": "금융감독원",
    "National Assembly": "국회",
    "Constitutional Court": "헌법재판소",
    # Policy nouns the LLM reliably translates
    "export control": "수출통제",
    "export controls": "수출통제",
    "export restrictions": "수출통제",
    "base interest rate": "기준금리",
    "base rate": "기준금리",
    "corporate bonds": "회사채",
    # Common government nouns
    "the Government": "정부",
    "government": "정부",
}

# Lower-cased lookup for case-insensitive English match.
_EN_TO_KO_LOWER: Final[dict[str, str]] = {
    k.strip().lower(): v for k, v in _KO_EN_ORG_DICT.items()
}


_HANGUL_RE = re.compile(r"[가-힣]")


def _has_hangul(text: str | None) -> bool:
    """Return True when `text` contains at least one Hangul syllable."""
    if not text:
        return False
    return bool(_HANGUL_RE.search(text))


def derive_korean_surface_from_claim(
    *,
    claim: str,
    llm_name_en: str | None,
    claim_lang: str | None = None,
) -> str | None:
    """Try to recover the Korean source-language surface for an entity
    whose LLM-emitted name is English.

    Returns the Korean substring found in `claim`, or None when:
      - `claim_lang` is supplied and is not 'ko',
      - `claim` has no Hangul,
      - `llm_name_en` is empty / falsy,
      - `llm_name_en` is brand-shaped (defer to English brand canonical),
      - no matching Korean form for `llm_name_en` is found in the claim.

    Strategy:
      1. Direct dict lookup: `llm_name_en` (case-folded) → Korean form.
         If that form appears in `claim`, return it.
      2. Fallback substring scan: any dictionary entry whose English
         key is contained in `llm_name_en` (handles 'X of China' style
         compounds) AND whose Korean value appears in `claim`. Return
         the LONGEST match (most specific).

    No LLM call. No fuzzy match. Conservative by design.
    """
    if claim_lang is not None and claim_lang != "ko":
        return None
    if not claim or not _has_hangul(claim):
        return None
    if not llm_name_en:
        return None
    name_lc = llm_name_en.strip().lower()
    if not name_lc:
        return None
    # Brand guard — single-token Latin like 'SpaceX' stays English.
    if _looks_like_brand(llm_name_en):
        return None

    # Step 1 — direct match.
    direct = _EN_TO_KO_LOWER.get(name_lc)
    if direct and direct in claim:
        return direct

    # Step 2 — partial substring of llm_name_en that maps to a Korean
    # form present in the claim. e.g. llm_name_en='Ministry of Commerce
    # of China', and 'Ministry of Commerce' is a dict key whose Korean
    # form 상무부 is in the claim. Pick the longest Korean match — the
    # most specific form wins (중국 상무부 over 상무부).
    candidates: list[str] = []
    for en_key, ko_val in _EN_TO_KO_LOWER.items():
        if en_key in name_lc and ko_val in claim:
            candidates.append(ko_val)
    if not candidates:
        return None
    return max(candidates, key=len)


__all__ = [
    "derive_korean_surface_from_claim",
    "_has_hangul",
]
