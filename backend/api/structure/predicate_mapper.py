"""B-62 structure-resolve - free-text predicate to OPL v0 code mapping.

The LLM extracts predicates as free-form strings (e.g. "founded_by",
"creates"). The CSVS Structure stage MUST collapse those onto the 10
OPL controlled-vocabulary codes seeded by migration 0015_data_bedrock:

    IS_A / HAS_VALUE / HAS_ATTRIBUTE / PART_OF / LOCATED_IN /
    FOUNDED_BY / LED_BY / PRODUCES / OCCURRED_ON /
    RELATED_TO (fallback - also flags needs_review).

The mapping is intentionally DETERMINISTIC: a hard-coded lookup table
followed by a light substring fallback over the same table. No LLM
call here - predicate resolution must never burn a token, and must
never be sensitive to prompt drift.

PO directive 2026-06-21 (B-62 structure-resolve):
  - free-text predicates banned on the canonical surface;
    predicate_code MUST be one of the 10 OPL codes.
  - ambiguous predicates degrade to RELATED_TO and the caller stamps
    needs_review=True on the fact so the HITL UI surfaces it.
"""
from __future__ import annotations

import re
import unicodedata

OPL_LOOKUP: dict[str, str] = {
    # FOUNDED_BY
    'founded_by': 'FOUNDED_BY',
    'founded by': 'FOUNDED_BY',
    'founder': 'FOUNDED_BY',
    'founders': 'FOUNDED_BY',
    'established_by': 'FOUNDED_BY',
    'establisher': 'FOUNDED_BY',
    'co_founder': 'FOUNDED_BY',
    'co-founder': 'FOUNDED_BY',
    '설립자': 'FOUNDED_BY',
    '창업자': 'FOUNDED_BY',
    '설립': 'FOUNDED_BY',
    '창립자': 'FOUNDED_BY',
    # LED_BY
    'led_by': 'LED_BY',
    'led by': 'LED_BY',
    'leader': 'LED_BY',
    'head_of': 'LED_BY',
    'ceo': 'LED_BY',
    'president': 'LED_BY',
    'director': 'LED_BY',
    'chairman': 'LED_BY',
    '수장': 'LED_BY',
    '대표': 'LED_BY',
    '대표이사': 'LED_BY',
    '이끌다': 'LED_BY',
    # IS_A
    'is_a': 'IS_A',
    'is a': 'IS_A',
    'is_type_of': 'IS_A',
    'instance_of': 'IS_A',
    'type_of': 'IS_A',
    'kind_of': 'IS_A',
    'category': 'IS_A',
    'classified_as': 'IS_A',
    '분류': 'IS_A',
    '종류': 'IS_A',
    '유형': 'IS_A',
    # HAS_VALUE
    'has_value': 'HAS_VALUE',
    'has value': 'HAS_VALUE',
    'value': 'HAS_VALUE',
    'equals': 'HAS_VALUE',
    '=': 'HAS_VALUE',
    'amount': 'HAS_VALUE',
    '값': 'HAS_VALUE',
    '수치': 'HAS_VALUE',
    '금액': 'HAS_VALUE',
    # HAS_ATTRIBUTE
    'has_attribute': 'HAS_ATTRIBUTE',
    'has attribute': 'HAS_ATTRIBUTE',
    'attribute': 'HAS_ATTRIBUTE',
    'is_known_for': 'HAS_ATTRIBUTE',
    'known_for': 'HAS_ATTRIBUTE',
    'feature': 'HAS_ATTRIBUTE',
    'characteristic': 'HAS_ATTRIBUTE',
    'property': 'HAS_ATTRIBUTE',
    '속성': 'HAS_ATTRIBUTE',
    '특징': 'HAS_ATTRIBUTE',
    '특성': 'HAS_ATTRIBUTE',
    # PART_OF
    'part_of': 'PART_OF',
    'part of': 'PART_OF',
    'member_of': 'PART_OF',
    'belongs_to': 'PART_OF',
    'subsidiary_of': 'PART_OF',
    'is_subsidiary_of': 'PART_OF',
    'under': 'PART_OF',
    'division_of': 'PART_OF',
    '구성': 'PART_OF',
    '구성요소': 'PART_OF',
    '산하': 'PART_OF',
    '산하기관': 'PART_OF',
    '소속': 'PART_OF',
    '포함': 'PART_OF',
    # LOCATED_IN
    'located_in': 'LOCATED_IN',
    'located in': 'LOCATED_IN',
    'is_located_in': 'LOCATED_IN',
    'based_in': 'LOCATED_IN',
    'in_country': 'LOCATED_IN',
    'at': 'LOCATED_IN',
    'headquartered_in': 'LOCATED_IN',
    '위치': 'LOCATED_IN',
    '위치한': 'LOCATED_IN',
    '본사': 'LOCATED_IN',
    '소재지': 'LOCATED_IN',
    # PRODUCES
    'produces': 'PRODUCES',
    'produce': 'PRODUCES',
    'makes': 'PRODUCES',
    'creates': 'PRODUCES',
    'create': 'PRODUCES',
    'manufactures': 'PRODUCES',
    'manufacture': 'PRODUCES',
    'develops': 'PRODUCES',
    'develop': 'PRODUCES',
    'builds': 'PRODUCES',
    '생산': 'PRODUCES',
    '제조': 'PRODUCES',
    '만들다': 'PRODUCES',
    '제작': 'PRODUCES',
    '개발': 'PRODUCES',
    # OCCURRED_ON
    'occurred_on': 'OCCURRED_ON',
    'occurred on': 'OCCURRED_ON',
    'happened_on': 'OCCURRED_ON',
    'date_of': 'OCCURRED_ON',
    'dated': 'OCCURRED_ON',
    'occurred': 'OCCURRED_ON',
    'happened': 'OCCURRED_ON',
    '발생일': 'OCCURRED_ON',
    '일자': 'OCCURRED_ON',
    '날짜': 'OCCURRED_ON',
    '발생': 'OCCURRED_ON',
}


# Multi-word substring cues used for the fallback scan. Ordered by
# specificity (longer / more-distinctive cues first) so we do not accept
# a generic match when a precise one is available.
SUBSTRING_CUES: list[tuple[str, str]] = [
    ('subsidiary', 'PART_OF'),
    ('member of', 'PART_OF'),
    ('belongs to', 'PART_OF'),
    ('located', 'LOCATED_IN'),
    ('based in', 'LOCATED_IN'),
    ('headquartered', 'LOCATED_IN'),
    ('founded', 'FOUNDED_BY'),
    ('founder', 'FOUNDED_BY'),
    ('established', 'FOUNDED_BY'),
    ('led by', 'LED_BY'),
    ('leads', 'LED_BY'),
    ('manages', 'LED_BY'),
    ('manufactur', 'PRODUCES'),
    ('produces', 'PRODUCES'),
    ('creates', 'PRODUCES'),
    ('makes', 'PRODUCES'),
    ('instance', 'IS_A'),
    ('category', 'IS_A'),
    ('attribute', 'HAS_ATTRIBUTE'),
    ('known for', 'HAS_ATTRIBUTE'),
    ('equals', 'HAS_VALUE'),
    ('value', 'HAS_VALUE'),
    ('happened', 'OCCURRED_ON'),
    ('occurred', 'OCCURRED_ON'),
    ('산하', 'PART_OF'),
    ('소속', 'PART_OF'),
    ('위치', 'LOCATED_IN'),
    ('설립', 'FOUNDED_BY'),
    ('창업', 'FOUNDED_BY'),
    ('생산', 'PRODUCES'),
    ('제조', 'PRODUCES'),
    ('개발', 'PRODUCES'),
    ('분류', 'IS_A'),
    ('속성', 'HAS_ATTRIBUTE'),
    ('특징', 'HAS_ATTRIBUTE'),
    ('값', 'HAS_VALUE'),
    ('날짜', 'OCCURRED_ON'),
    ('일자', 'OCCURRED_ON'),
]


# Strip common ASCII punctuation; leave Hangul / latin word chars intact.
# Brackets are listed explicitly via escaping inside the char class.
_PUNCT_RE = re.compile(r"[!#$%&()*+,./:;<=>?@^`{|}~\"\'\\\[\]]")


def _normalize(raw: str) -> str:
    """Lowercase + NFC + collapse whitespace + strip ASCII punctuation."""
    if not raw:
        return ""
    s = unicodedata.normalize("NFC", raw).strip().lower()
    s = _PUNCT_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def map_predicate_to_opl(
    raw_predicate: str,
    *,
    subject_lang: str | None = None,
    object_lang: str | None = None,
) -> tuple[str, bool]:
    """Map a free-text predicate to an OPL v0 code.

    Returns (opl_code, needs_review). needs_review=True iff the
    predicate fell back to RELATED_TO - the caller should stamp
    needs_review on the fact so the HITL UI surfaces it.

    Strategy:
      1. Exact match on the normalized form against OPL_LOOKUP.
      2. Hyphen / underscore / space variants via swap.
      3. Substring fallback over SUBSTRING_CUES (ordered).
      4. RELATED_TO + needs_review=True.

    subject_lang and object_lang are reserved for future language-aware
    tie-breaks (currently unused).
    """
    del subject_lang, object_lang  # reserved

    if raw_predicate is None or not str(raw_predicate).strip():
        return "RELATED_TO", True

    norm = _normalize(raw_predicate)
    if not norm:
        return "RELATED_TO", True

    direct = OPL_LOOKUP.get(norm)
    if direct is not None:
        return direct, False

    underscored = norm.replace(" ", "_")
    if underscored in OPL_LOOKUP:
        return OPL_LOOKUP[underscored], False
    spaced = norm.replace("_", " ")
    if spaced in OPL_LOOKUP:
        return OPL_LOOKUP[spaced], False

    for cue, code in SUBSTRING_CUES:
        if cue in norm:
            return code, False

    return "RELATED_TO", True


__all__ = ["map_predicate_to_opl", "OPL_LOOKUP", "SUBSTRING_CUES"]
