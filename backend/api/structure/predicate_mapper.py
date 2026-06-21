"""B-62 structure-resolve - free-text predicate to OPL v0/v1 code + label mapping.

The LLM extracts predicates as free-form strings (e.g. "founded_by",
"creates", "회사채 발행 계획"). The CSVS Structure stage MUST collapse
those onto the controlled OPL vocabulary seeded by migrations
0015_data_bedrock (10 v0 codes) and 0016_opl_v1_expansion (~20 v1 codes).

    v0: IS_A / HAS_VALUE / HAS_ATTRIBUTE / PART_OF / LOCATED_IN /
        FOUNDED_BY / LED_BY / PRODUCES / OCCURRED_ON /
        RELATED_TO (fallback - also flags needs_review).
    v1: PLANS / DISCUSSES / ESTIMATES / INTENDS / REPORTS / DEFINES /
        CAUSES / ANNOUNCES / ACQUIRES / INVESTS_IN / PARTNERS_WITH /
        EMPLOYS / COMPETES_WITH / TARGETS / PRICED_AT / RAISES /
        ALLOCATES / HAS_RATE / APPROVES / REGULATES.

The mapping is intentionally DETERMINISTIC: a hard-coded lookup table
followed by a light substring fallback over the same table. No LLM
call here - predicate resolution must never burn a token, and must
never be sensitive to prompt drift.

B-62 natural-spo-display:
  - `map_predicate_to_type_and_label` returns (opl_code, english_label,
    needs_review). The label is the user-facing display string —
    a humanised, idiomatic English gloss preserved as-is on the fact
    doc. It does NOT participate in the canonical_key (dedup is type-
    based; label is purely a display facet).
  - Korean gloss dictionary maps common Korean predicate surfaces to
    a curated English label so a Korean capture becomes
    "plans bond issuance" rather than the bare "PLANS" code.
  - English idiomatic input echoes verbatim — if the LLM emits
    "issues bonds for funding" we trust it as the natural surface.
  - The legacy `map_predicate_to_opl(raw)` returns (code, needs_review)
    and stays as a thin wrapper for back-compat.

PO directive 2026-06-21 (B-62 structure-resolve):
  - free-text predicates banned on the canonical surface;
    predicate_code MUST be one of the controlled OPL codes.
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
    # --- B-62 OPL v1 expansion --------------------------------------------
    # PLANS
    'plans': 'PLANS',
    'plan': 'PLANS',
    'plans_to': 'PLANS',
    'is_planning': 'PLANS',
    'planning': 'PLANS',
    'plans_bond_issuance': 'PLANS',
    '계획': 'PLANS',
    '발행 계획': 'PLANS',
    '회사채 발행 계획': 'PLANS',
    # DISCUSSES
    'discusses': 'DISCUSSES',
    'discuss': 'DISCUSSES',
    'is_examining': 'DISCUSSES',
    'examines': 'DISCUSSES',
    'reviews': 'DISCUSSES',
    'review': 'DISCUSSES',
    'considering': 'DISCUSSES',
    '논의': 'DISCUSSES',
    '검토': 'DISCUSSES',
    # ESTIMATES
    'estimates': 'ESTIMATES',
    'estimate': 'ESTIMATES',
    'projects': 'ESTIMATES',
    'forecasts': 'ESTIMATES',
    'forecast': 'ESTIMATES',
    '추정': 'ESTIMATES',
    '예상': 'ESTIMATES',
    '전망': 'ESTIMATES',
    # INTENDS
    'intends': 'INTENDS',
    'intend': 'INTENDS',
    'aims_to': 'INTENDS',
    'will': 'INTENDS',
    '의도': 'INTENDS',
    '목적': 'INTENDS',
    # REPORTS
    'reports': 'REPORTS',
    'report': 'REPORTS',
    'reported': 'REPORTS',
    'reporting': 'REPORTS',
    '보고': 'REPORTS',
    '보고서': 'REPORTS',
    # DEFINES
    'defines': 'DEFINES',
    'define': 'DEFINES',
    'defined_as': 'DEFINES',
    'means': 'DEFINES',
    '정의': 'DEFINES',
    # CAUSES
    'causes': 'CAUSES',
    'cause': 'CAUSES',
    'caused_by': 'CAUSES',
    'triggers': 'CAUSES',
    'triggered': 'CAUSES',
    'leads_to': 'CAUSES',
    '원인': 'CAUSES',
    '야기': 'CAUSES',
    # ANNOUNCES
    'announces': 'ANNOUNCES',
    'announce': 'ANNOUNCES',
    'announced': 'ANNOUNCES',
    'unveils': 'ANNOUNCES',
    '발표': 'ANNOUNCES',
    '공개': 'ANNOUNCES',
    # ACQUIRES
    'acquires': 'ACQUIRES',
    'acquire': 'ACQUIRES',
    'acquired': 'ACQUIRES',
    'buys_out': 'ACQUIRES',
    '인수': 'ACQUIRES',
    # INVESTS_IN
    'invests_in': 'INVESTS_IN',
    'invests in': 'INVESTS_IN',
    'invest_in': 'INVESTS_IN',
    'invests': 'INVESTS_IN',
    'invested_in': 'INVESTS_IN',
    '투자': 'INVESTS_IN',
    # PARTNERS_WITH
    'partners_with': 'PARTNERS_WITH',
    'partners with': 'PARTNERS_WITH',
    'partner_with': 'PARTNERS_WITH',
    'collaborates_with': 'PARTNERS_WITH',
    '제휴': 'PARTNERS_WITH',
    '협력': 'PARTNERS_WITH',
    # EMPLOYS
    'employs': 'EMPLOYS',
    'employ': 'EMPLOYS',
    'hires': 'EMPLOYS',
    'hired': 'EMPLOYS',
    'works_at': 'EMPLOYS',
    '고용': 'EMPLOYS',
    '채용': 'EMPLOYS',
    # COMPETES_WITH
    'competes_with': 'COMPETES_WITH',
    'competes with': 'COMPETES_WITH',
    'competitor_of': 'COMPETES_WITH',
    'rival_of': 'COMPETES_WITH',
    '경쟁': 'COMPETES_WITH',
    # TARGETS
    'targets': 'TARGETS',
    'target': 'TARGETS',
    'aims_at': 'TARGETS',
    '대상': 'TARGETS',
    '목표': 'TARGETS',
    # PRICED_AT
    'priced_at': 'PRICED_AT',
    'priced at': 'PRICED_AT',
    'price': 'PRICED_AT',
    'set_price': 'PRICED_AT',
    'costs': 'PRICED_AT',
    '가격': 'PRICED_AT',
    '공모가': 'PRICED_AT',
    # RAISES
    'raises': 'RAISES',
    'raise': 'RAISES',
    'raised': 'RAISES',
    'raised_funding': 'RAISES',
    '조달': 'RAISES',
    '모집': 'RAISES',
    # ALLOCATES
    'allocates': 'ALLOCATES',
    'allocated': 'ALLOCATES',
    'allocates_to': 'ALLOCATES',
    'allocated_to': 'ALLOCATES',
    'allocation': 'ALLOCATES',
    '배정': 'ALLOCATES',
    # HAS_RATE
    'has_rate': 'HAS_RATE',
    'rate': 'HAS_RATE',
    'interest_rate': 'HAS_RATE',
    'base_rate': 'HAS_RATE',
    '비율': 'HAS_RATE',
    '금리': 'HAS_RATE',
    '기준금리': 'HAS_RATE',
    # APPROVES
    'approves': 'APPROVES',
    'approve': 'APPROVES',
    'approved': 'APPROVES',
    'authorizes': 'APPROVES',
    '승인': 'APPROVES',
    '허가': 'APPROVES',
    # REGULATES
    'regulates': 'REGULATES',
    'regulate': 'REGULATES',
    'regulated_by': 'REGULATES',
    'oversees': 'REGULATES',
    '규제': 'REGULATES',
    '감독': 'REGULATES',
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
    # B-62 v1 cues — more specific cues come first.
    ('bond issuance', 'PLANS'),
    ('issuance plan', 'PLANS'),
    ('plans to', 'PLANS'),
    ('plan', 'PLANS'),
    ('계획', 'PLANS'),
    ('discuss', 'DISCUSSES'),
    ('examin', 'DISCUSSES'),
    ('검토', 'DISCUSSES'),
    ('논의', 'DISCUSSES'),
    ('estimate', 'ESTIMATES'),
    ('forecast', 'ESTIMATES'),
    ('전망', 'ESTIMATES'),
    ('예상', 'ESTIMATES'),
    ('intend', 'INTENDS'),
    ('aims', 'INTENDS'),
    ('report', 'REPORTS'),
    ('보고', 'REPORTS'),
    ('define', 'DEFINES'),
    ('정의', 'DEFINES'),
    ('cause', 'CAUSES'),
    ('trigger', 'CAUSES'),
    ('원인', 'CAUSES'),
    ('announce', 'ANNOUNCES'),
    ('unveil', 'ANNOUNCES'),
    ('발표', 'ANNOUNCES'),
    ('공개', 'ANNOUNCES'),
    ('acquire', 'ACQUIRES'),
    ('인수', 'ACQUIRES'),
    ('invest', 'INVESTS_IN'),
    ('투자', 'INVESTS_IN'),
    ('partner', 'PARTNERS_WITH'),
    ('collaborat', 'PARTNERS_WITH'),
    ('제휴', 'PARTNERS_WITH'),
    ('협력', 'PARTNERS_WITH'),
    ('employ', 'EMPLOYS'),
    ('hire', 'EMPLOYS'),
    ('고용', 'EMPLOYS'),
    ('채용', 'EMPLOYS'),
    ('compet', 'COMPETES_WITH'),
    ('rival', 'COMPETES_WITH'),
    ('경쟁', 'COMPETES_WITH'),
    ('target', 'TARGETS'),
    ('목표', 'TARGETS'),
    ('priced', 'PRICED_AT'),
    ('공모가', 'PRICED_AT'),
    ('가격', 'PRICED_AT'),
    ('raise', 'RAISES'),
    ('조달', 'RAISES'),
    ('allocat', 'ALLOCATES'),
    ('배정', 'ALLOCATES'),
    ('interest rate', 'HAS_RATE'),
    ('base rate', 'HAS_RATE'),
    ('기준금리', 'HAS_RATE'),
    ('금리', 'HAS_RATE'),
    ('approve', 'APPROVES'),
    ('승인', 'APPROVES'),
    ('허가', 'APPROVES'),
    ('regulat', 'REGULATES'),
    ('oversee', 'REGULATES'),
    ('규제', 'REGULATES'),
    ('감독', 'REGULATES'),
]


# B-62 natural-spo-display: Korean (and a handful of common multi-word
# English) surface predicates -> idiomatic English label. The label is
# what the user sees in recall; it does NOT participate in the dedup
# canonical_key. Keys are the post-normalised input (lowercased, NFC,
# whitespace-collapsed) so a Korean string maps cleanly.
_KO_TO_EN_GLOSS: dict[str, str] = {
    # finance / planning
    "회사채 발행 계획": "plans bond issuance",
    "발행 계획": "plans issuance",
    "계획": "plans",
    "검토": "discusses",
    "논의": "discusses",
    "추정": "estimates",
    "예상": "estimates",
    "전망": "forecasts",
    "보고": "reports",
    "보고서": "reports on",
    "발표": "announces",
    "공개": "announces",
    "인수": "acquires",
    "투자": "invests in",
    "제휴": "partners with",
    "협력": "collaborates with",
    "고용": "employs",
    "채용": "hires",
    "경쟁": "competes with",
    "대상": "targets",
    "목표": "targets",
    "가격": "priced at",
    "공모가": "priced at",
    "조달": "raises",
    "모집": "raises",
    "배정": "allocates",
    "비율": "has rate",
    "금리": "has rate",
    "기준금리": "has base rate of",
    "승인": "approves",
    "허가": "approves",
    "규제": "regulates",
    "감독": "oversees",
    "정의": "defines",
    "원인": "causes",
    "야기": "causes",
    "의도": "intends",
    "목적": "intends",
    # v0 surface coverage so a Korean v0 surface still glosses nicely.
    "설립자": "founded by",
    "창업자": "founded by",
    "설립": "founded by",
    "수장": "led by",
    "대표": "led by",
    "대표이사": "led by",
    "분류": "is a",
    "종류": "is a",
    "유형": "is a",
    "값": "has value",
    "수치": "has value",
    "금액": "has value",
    "속성": "has attribute",
    "특징": "has attribute",
    "특성": "has attribute",
    "구성": "part of",
    "산하": "part of",
    "산하기관": "part of",
    "소속": "part of",
    "위치": "located in",
    "본사": "headquartered in",
    "소재지": "located in",
    "생산": "produces",
    "제조": "produces",
    "제작": "produces",
    "개발": "develops",
    "발생일": "occurred on",
    "일자": "occurred on",
    "날짜": "occurred on",
    "발생": "occurred",
}


# Strip common ASCII punctuation; leave Hangul / latin word chars intact.
# Brackets are listed explicitly via escaping inside the char class.
_PUNCT_RE = re.compile(r"[!#$%&()*+,./:;<=>?@^`{|}~\"\'\\\[\]]")

# Matches a string that is "obviously English" (only ASCII letters,
# digits, spaces, hyphens, underscores). When the LLM emits one of
# these we trust it as the natural surface and echo it back verbatim
# (after de-snake-casing).
_ASCII_LATIN_ONLY_RE = re.compile(r"^[\sA-Za-z0-9_\-]+$")


def _normalize(raw: str) -> str:
    """Lowercase + NFC + collapse whitespace + strip ASCII punctuation."""
    if not raw:
        return ""
    s = unicodedata.normalize("NFC", raw).strip().lower()
    s = _PUNCT_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _humanise_opl_code(code: str) -> str:
    """PLANS_BOND_ISSUANCE -> "plans bond issuance" — replace _ with
    space and lowercase. Empty string in => empty string out."""
    if not code:
        return ""
    return code.replace("_", " ").lower()


def _looks_english(raw: str) -> bool:
    """True iff the raw input is pure ASCII letters / digits / spaces /
    hyphens / underscores. Used to decide whether to echo the LLM
    surface verbatim or translate via the gloss dict."""
    if not raw:
        return False
    return bool(_ASCII_LATIN_ONLY_RE.match(raw))


def _gloss_lookup(norm: str) -> str | None:
    """Return the curated English gloss for a normalized surface, or
    a partial-match gloss (longest-key-wins) if any gloss-dict key
    is a substring of `norm`. None when nothing matches."""
    if not norm:
        return None
    direct = _KO_TO_EN_GLOSS.get(norm)
    if direct is not None:
        return direct
    # Partial match: pick the LONGEST gloss key that appears as a
    # substring of the input. This way "회사채 발행 계획" picks the
    # specific "plans bond issuance" gloss rather than the generic
    # "plans" gloss for "계획".
    best_key: str | None = None
    for key in _KO_TO_EN_GLOSS:
        if key and key in norm and (best_key is None or len(key) > len(best_key)):
            best_key = key
    if best_key is not None:
        return _KO_TO_EN_GLOSS[best_key]
    return None


def _resolve_opl_code(
    raw_predicate: str,
    *,
    subject_lang: str | None,
    object_lang: str | None,
) -> tuple[str, bool]:
    """Internal: deterministic OPL code resolution.

    Returns (opl_code, needs_review). Mirrors the original
    `map_predicate_to_opl` strategy, kept as a private helper so the
    new public `map_predicate_to_type_and_label` and the legacy
    `map_predicate_to_opl` both share the same code path.
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


def map_predicate_to_type_and_label(
    raw_predicate: str,
    *,
    subject_lang: str | None = None,
    object_lang: str | None = None,
) -> tuple[str, str, bool]:
    """Map a free-text predicate to (opl_code, english_label, needs_review).

    The label is the user-facing natural English surface preserved on
    the fact doc as `predicate_label`. The OPL code is the dedup key
    segment. Two captures with different labels but the same canonical
    type and object collapse via canonical_key (the label is NEVER
    part of the dedup key — invariant locked by the integration tests).

    Strategy:
      1. Resolve the OPL code via the deterministic lookup.
      2. RELATED_TO fallback -> label = "related to", needs_review=True.
      3. Else: pick the english label by precedence:
           a. Korean (or curated) gloss dict (longest substring wins).
           b. Echo the raw input when it looks English (de-snake-cased).
           c. Humanise the OPL code (PLANS_BOND_ISSUANCE -> "plans bond
              issuance").
    """
    code, needs_review = _resolve_opl_code(
        raw_predicate, subject_lang=subject_lang, object_lang=object_lang,
    )
    if code == "RELATED_TO":
        # Ambiguous predicates always get "related to" and needs_review
        # so the HITL UI can ask the user to disambiguate.
        return code, "related to", needs_review

    raw_str = str(raw_predicate or "").strip()
    norm = _normalize(raw_str)

    # Precedence 1: curated gloss dictionary.
    glossed = _gloss_lookup(norm)
    if glossed:
        return code, glossed, needs_review

    # Precedence 2: looks English -> echo verbatim (de-snake-cased,
    # lower-cased). This is the "trust the LLM" natural-phrasing path
    # — e.g. "issues bonds for funding" comes through unchanged.
    if _looks_english(raw_str):
        echo = raw_str.replace("_", " ").strip()
        # Collapse internal whitespace runs to single spaces.
        echo = re.sub(r"\s+", " ", echo).lower()
        if echo:
            return code, echo, needs_review

    # Precedence 3: humanise the OPL code itself.
    return code, _humanise_opl_code(code), needs_review


def map_predicate_to_opl(
    raw_predicate: str,
    *,
    subject_lang: str | None = None,
    object_lang: str | None = None,
) -> tuple[str, bool]:
    """Legacy entry point. Returns (opl_code, needs_review).

    Kept as a thin wrapper around `map_predicate_to_type_and_label`
    so existing call sites that do not need the english label keep
    working. New call sites SHOULD prefer the three-tuple variant so
    the fact doc carries `predicate_label` end-to-end.
    """
    code, _label, needs_review = map_predicate_to_type_and_label(
        raw_predicate, subject_lang=subject_lang, object_lang=object_lang,
    )
    return code, needs_review


__all__ = [
    "map_predicate_to_opl",
    "map_predicate_to_type_and_label",
    "OPL_LOOKUP",
    "SUBSTRING_CUES",
]
