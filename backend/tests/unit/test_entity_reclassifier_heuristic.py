"""Unit tests for the Korean-name heuristic in entity_reclassifier.

These are pure-function tests — no ES, no LLM, no network. They pin
the contract that the 41 legacy concept entities in the PO's KS will
be triaged correctly by shape alone (the LLM only sees the hard
cases like foreign brand names).
"""
from __future__ import annotations

import pytest

from api.structure.entity_reclassifier import classify_by_heuristic

# ---------------------------------------------------------------------------
# Persons — 2-4 Hangul syllables, no whitespace, no org/loc suffix
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "위철환",   # 3-syllable Korean name
        "노태악",   # 3-syllable Korean name
        "정청래",   # 3-syllable Korean name
        "김민석",   # 3-syllable Korean name
        "서범수",   # 3-syllable Korean name
        "김은혜",   # 3-syllable Korean name
    ],
)
def test_three_syllable_korean_names_are_persons(name: str) -> None:
    assert classify_by_heuristic(name) == "person"


# ---------------------------------------------------------------------------
# Organizations — name ends with a known org suffix
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "더불어민주당",       # ends 당 (political party)
        "선거관리위원회",     # ends 회 (committee)
        "중국 상무부",         # ends 부 (ministry)
        "청와대",              # ends 대 (covered by 대학 prefix-suffix order? no — 대 is in suffix list)
        "선관위 무능",         # NO suffix — should fall through (NOT testing here)
        "정부서울청사",        # ends 사 — should NOT be 'person' despite 4-Hangul shape
        "국정조사특별위원회",  # ends 회
    ],
)
def test_korean_org_suffixes_are_orgs(name: str) -> None:
    # All these should match 'organization' because the suffix-check
    # runs before the person heuristic.
    if name == "선관위 무능":
        # Whitespace + no suffix => None (deferred to LLM). Document
        # this carve-out rather than silently expect 'organization'.
        assert classify_by_heuristic(name) is None
    else:
        assert classify_by_heuristic(name) == "organization"


def test_government_building_is_organization_not_person() -> None:
    """정부서울청사 is 4 Hangul but ends 사 — the org-suffix check must
    win over the person-shape check, otherwise it would be misclassified
    as a person."""
    assert classify_by_heuristic("정부서울청사") == "organization"


# ---------------------------------------------------------------------------
# Locations — country whitelist
# ---------------------------------------------------------------------------

def test_korea_country_short_form_is_location() -> None:
    # 미국 is 2 Hangul — would otherwise match person shape. The
    # whitelist must come BEFORE the person check.
    assert classify_by_heuristic("미국") == "place"


@pytest.mark.parametrize("name", ["중국", "일본", "한국", "영국"])
def test_other_whitelist_countries_are_place(name: str) -> None:
    assert classify_by_heuristic(name) == "place"


# ---------------------------------------------------------------------------
# Ambiguous — should return None and let the LLM decide
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "록히드마틴",                       # foreign company, no Korean suffix
        "L3해리스 해양서비스",             # mixed Latin+Korean+whitespace
        "MP머티리얼스",                     # mixed Latin+Korean
        "정부조달 금지 대상 기업 수",       # long phrase, true concept
        "수출통제 대상 기업 수",            # long phrase, true concept
        "원포인트 개헌",                    # abstract concept
        "이중용도 품목",                    # abstract concept
        "",                                  # empty -> None
        "   ",                               # whitespace only -> None
    ],
)
def test_ambiguous_names_defer_to_llm(name: str) -> None:
    assert classify_by_heuristic(name) is None


# ---------------------------------------------------------------------------
# Aliases — Korean alias on an entity with English primary
# ---------------------------------------------------------------------------

def test_korean_alias_promotes_to_person() -> None:
    # English primary, Korean alias — alias should be enough to trip the
    # person heuristic.
    assert classify_by_heuristic(
        "Jung Cheong-rae", aliases=["정청래"]
    ) == "person"


def test_korean_alias_promotes_to_organization() -> None:
    assert classify_by_heuristic(
        "Democratic Party of Korea", aliases=["더불어민주당"]
    ) == "organization"
