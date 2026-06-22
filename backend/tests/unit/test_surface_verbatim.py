"""B-62-fix-v3-general unit tests for the verbatim-substring mechanism.

Tests the deterministic primitives that replace the prior curated
KO↔EN dictionary:
  - `has_hangul`
  - `strip_korean_particles`
  - `is_verbatim_substring`
  - `detect_violation` (the load-bearing rule)
"""
from __future__ import annotations

from api.structure.surface_extractor import (
    detect_violation,
    has_hangul,
    is_verbatim_substring,
    strip_korean_particles,
)

# ---------------------------------------------------------------------------
# has_hangul
# ---------------------------------------------------------------------------


def test_has_hangul_positive() -> None:
    assert has_hangul("중국 상무부") is True
    assert has_hangul("안도걸 의원") is True
    assert has_hangul("Mixed 한글 string") is True


def test_has_hangul_negative() -> None:
    assert has_hangul("Ministry of Commerce") is False
    assert has_hangul("SpaceX") is False
    assert has_hangul("123 456") is False


def test_has_hangul_empty_and_none() -> None:
    assert has_hangul("") is False
    assert has_hangul(None) is False


# ---------------------------------------------------------------------------
# strip_korean_particles
# ---------------------------------------------------------------------------


def test_strip_korean_particles_topic() -> None:
    assert strip_korean_particles("중국 상무부는") == "중국 상무부"
    assert strip_korean_particles("삼성전자가") == "삼성전자"
    assert strip_korean_particles("정부의") == "정부"


def test_strip_korean_particles_no_op_for_english() -> None:
    assert strip_korean_particles("SpaceX") == "SpaceX"
    assert strip_korean_particles("Lockheed Martin") == "Lockheed Martin"


def test_strip_korean_particles_no_op_when_no_particle() -> None:
    # Trailing 'X' or '행' are not particles — pass through.
    assert strip_korean_particles("우리은행") == "우리은행"
    assert strip_korean_particles("스페이스X") == "스페이스X"


def test_strip_korean_particles_empty() -> None:
    assert strip_korean_particles("") == ""
    assert strip_korean_particles(None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# is_verbatim_substring
# ---------------------------------------------------------------------------


def test_is_verbatim_substring_korean_in_korean() -> None:
    """Korean surface verbatim in Korean claim."""
    assert is_verbatim_substring(
        "중국 상무부",
        "중국 상무부는 새로운 수출통제 조치를 발표했다.",
    ) is True


def test_is_verbatim_substring_with_particle_in_surface() -> None:
    """Surface may carry a trailing particle; substring is found
    after stripping."""
    assert is_verbatim_substring(
        "중국 상무부는",
        "중국 상무부 관계자가 발표했다.",
    ) is True


def test_is_verbatim_substring_english_in_english() -> None:
    assert is_verbatim_substring(
        "Lockheed Martin",
        "Lockheed Martin announced a new drone line.",
    ) is True


def test_is_verbatim_substring_english_not_in_korean() -> None:
    """English surface NOT in Korean source = not verbatim."""
    assert is_verbatim_substring(
        "Ministry of Commerce of China",
        "중국 상무부는 새로운 수출통제 조치를 발표했다.",
    ) is False


def test_is_verbatim_substring_empty() -> None:
    assert is_verbatim_substring("", "anything") is False
    assert is_verbatim_substring("anything", "") is False


# ---------------------------------------------------------------------------
# detect_violation (the load-bearing rule)
# ---------------------------------------------------------------------------


def test_detect_violation_korean_source_english_non_brand_non_substring() -> None:
    """The canonical violation case: Korean claim, English surface,
    not brand-shaped, not a substring of the claim."""
    assert detect_violation(
        surface="Ministry of Commerce of China",
        source="중국 상무부는 새로운 수출통제 조치를 발표했다.",
        looks_like_brand=False,
    ) is True


def test_detect_violation_korean_source_english_brand_is_not_violation() -> None:
    """English brand on Korean text is legitimate (SpaceX, OpenAI)."""
    assert detect_violation(
        surface="SpaceX",
        source="SpaceX는 보통주를 매각해 750억달러를 조달했다.",
        looks_like_brand=True,
    ) is False


def test_detect_violation_korean_source_korean_surface_is_not_violation() -> None:
    """LLM preserved Korean — no violation."""
    assert detect_violation(
        surface="중국 상무부",
        source="중국 상무부는 새로운 수출통제 조치를 발표했다.",
        looks_like_brand=False,
    ) is False


def test_detect_violation_english_source_english_surface_is_not_violation() -> None:
    """English source, English surface — outside the rule's scope."""
    assert detect_violation(
        surface="Ministry of Commerce",
        source="The Ministry of Commerce announced new measures.",
        looks_like_brand=False,
    ) is False


def test_detect_violation_lockheed_martin_in_korean_source_is_not_violation() -> None:
    """Multi-word English NOT brand-shaped, but IS a verbatim substring
    of the Korean source — no violation (legitimate English entity in
    Korean text)."""
    assert detect_violation(
        surface="Lockheed Martin",
        source="Lockheed Martin이 새 무기 체계를 발표했다.",
        looks_like_brand=False,
    ) is False


def test_detect_violation_person_name_anglicized_is_violation() -> None:
    """The core generality proof: a person name (안도걸 → Ahn Do-geol)
    that the dictionary band-aid never covered. The general
    verbatim rule catches it."""
    assert detect_violation(
        surface="Ahn Do-geol",
        source="안도걸 더불어민주당 의원이 발표했다.",
        looks_like_brand=False,
    ) is True


def test_detect_violation_arbitrary_korean_company_anglicized_is_violation() -> None:
    """Arbitrary Korean company NOT in any curated dict (우리자산운용
    → Woori Asset Management). The general rule catches it."""
    assert detect_violation(
        surface="Woori Asset Management",
        source="우리자산운용은 ETF를 운용한다.",
        looks_like_brand=False,
    ) is True
