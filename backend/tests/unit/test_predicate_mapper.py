"""B-62 structure-resolve - predicate_mapper unit tests.

Covers all 10 OPL codes with both Korean and English surface forms,
ambiguous-predicate fallback to RELATED_TO + needs_review, and the
normalization rules (case-insensitive, whitespace-tolerant, empty).
"""
from __future__ import annotations

import pytest

from api.structure.predicate_mapper import map_predicate_to_opl

# --- 10 OPL codes, each via at least one Korean and one English form ----


def test_is_a_english() -> None:
    code, needs_review = map_predicate_to_opl("is_a")
    assert code == "IS_A"
    assert needs_review is False


def test_is_a_korean() -> None:
    code, needs_review = map_predicate_to_opl("분류")
    assert code == "IS_A"
    assert needs_review is False


def test_has_value_english() -> None:
    code, _ = map_predicate_to_opl("has_value")
    assert code == "HAS_VALUE"


def test_has_value_korean() -> None:
    code, _ = map_predicate_to_opl("값")
    assert code == "HAS_VALUE"


def test_has_attribute_english() -> None:
    code, _ = map_predicate_to_opl("is_known_for")
    assert code == "HAS_ATTRIBUTE"


def test_has_attribute_korean() -> None:
    code, _ = map_predicate_to_opl("속성")
    assert code == "HAS_ATTRIBUTE"


def test_part_of_english() -> None:
    code, _ = map_predicate_to_opl("part_of")
    assert code == "PART_OF"


def test_part_of_korean() -> None:
    code, _ = map_predicate_to_opl("산하기관")
    assert code == "PART_OF"


def test_located_in_english() -> None:
    code, _ = map_predicate_to_opl("located_in")
    assert code == "LOCATED_IN"


def test_located_in_korean() -> None:
    code, _ = map_predicate_to_opl("위치")
    assert code == "LOCATED_IN"


def test_founded_by_english() -> None:
    code, needs_review = map_predicate_to_opl("founded_by")
    assert code == "FOUNDED_BY"
    assert needs_review is False


def test_founded_by_korean() -> None:
    code, _ = map_predicate_to_opl("설립자")
    assert code == "FOUNDED_BY"


def test_led_by_english() -> None:
    code, _ = map_predicate_to_opl("ceo")
    assert code == "LED_BY"


def test_led_by_korean() -> None:
    code, _ = map_predicate_to_opl("수장")
    assert code == "LED_BY"


def test_produces_english() -> None:
    code, _ = map_predicate_to_opl("manufactures")
    assert code == "PRODUCES"


def test_produces_korean() -> None:
    code, _ = map_predicate_to_opl("생산")
    assert code == "PRODUCES"


def test_occurred_on_english() -> None:
    code, _ = map_predicate_to_opl("occurred_on")
    assert code == "OCCURRED_ON"


def test_occurred_on_korean() -> None:
    code, _ = map_predicate_to_opl("발생일")
    assert code == "OCCURRED_ON"


# --- Substring / semantic neighborhood fallback -----------------------------


def test_substring_fallback_subsidiary_maps_to_part_of() -> None:
    """The cue list catches `is_subsidiary_of` even though the exact
    surface isn't a direct OPL alias."""
    code, needs_review = map_predicate_to_opl("is_subsidiary_of")
    assert code == "PART_OF"
    assert needs_review is False


def test_substring_fallback_headquartered_maps_to_located_in() -> None:
    code, _ = map_predicate_to_opl("is_headquartered_in_korea")
    assert code == "LOCATED_IN"


# --- Ambiguous predicates fall back to RELATED_TO + needs_review ----------


def test_ambiguous_predicate_falls_back_to_related_to() -> None:
    code, needs_review = map_predicate_to_opl("is_friend_with")
    assert code == "RELATED_TO"
    assert needs_review is True


def test_unknown_predicate_falls_back_to_related_to() -> None:
    code, needs_review = map_predicate_to_opl("xyz_quux_blat")
    assert code == "RELATED_TO"
    assert needs_review is True


# --- Normalization / robustness ------------------------------------------


def test_case_insensitive_uppercase_match() -> None:
    code, needs_review = map_predicate_to_opl("FOUNDED_BY")
    assert code == "FOUNDED_BY"
    assert needs_review is False


def test_case_insensitive_mixed_case_with_space() -> None:
    code, needs_review = map_predicate_to_opl("Founded By")
    assert code == "FOUNDED_BY"
    assert needs_review is False


def test_whitespace_tolerant() -> None:
    code, _ = map_predicate_to_opl("  founded  by  ")
    assert code == "FOUNDED_BY"


def test_empty_string_falls_back_to_related_to() -> None:
    code, needs_review = map_predicate_to_opl("")
    assert code == "RELATED_TO"
    assert needs_review is True


def test_none_input_falls_back_to_related_to() -> None:
    code, needs_review = map_predicate_to_opl(None)  # type: ignore[arg-type]
    assert code == "RELATED_TO"
    assert needs_review is True


def test_underscore_space_variant_match() -> None:
    code_a, _ = map_predicate_to_opl("led by")
    code_b, _ = map_predicate_to_opl("led_by")
    assert code_a == code_b == "LED_BY"
