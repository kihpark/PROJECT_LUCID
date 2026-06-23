"""feat/spo-decomp-completeness — unit tests for completeness_validator.

Live PO evidence cases (2026-06-23):
  Bad : S="중국" P="올렸다" O="10곳"
  Good: S="중국 정부" P="수출통제 대상에 올렸다" O="미국 기업 10곳"
        claim="중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다."

Bad : S="중국" P="제재" O="추가 제재"
Good: S="중국 정부" P="추가 제재에 나섰다" O="미국 방산·드론·희토류 관련 기업"

We also verify English path, threshold tuning, empty-claim handling,
particle stripping, and stop-word ignoring.
"""
from __future__ import annotations

from api.structure.completeness_validator import (
    _tokenize,
    check_completeness,
)

# ---------------------------------------------------------------------------
# 1-3 — PO's live evidence cases
# ---------------------------------------------------------------------------


def test_good_korean_decomp_passes() -> None:
    """The CORRECT decomposition from PO's example covers 100% of claim
    content tokens.
    """
    result = check_completeness(
        claim="중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        subject="중국 정부",
        predicate="수출통제 대상에 올렸다",
        object_text="미국 기업 10곳",
    )
    assert result["complete"] is True
    assert result["coverage"] == 1.0
    assert result["missing"] == []


def test_bad_korean_decomp_fails_missing_modifier() -> None:
    """The BAD decomposition from PO's example drops 수출통제 / 대상 /
    미국 / 기업 / 정부 — coverage well below threshold.
    """
    result = check_completeness(
        claim="중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        subject="중국",
        predicate="올렸다",
        object_text="10곳",
    )
    assert result["complete"] is False
    assert result["coverage"] < 0.7
    missing = set(result["missing"])  # type: ignore[arg-type]
    # The big anchors: 수출통제 / 대상 / 미국 / 기업 must appear in missing
    assert "수출통제" in missing
    assert "대상" in missing
    assert "미국" in missing
    assert "기업" in missing


def test_bad_korean_decomp_drops_compound_modifiers() -> None:
    """PO's second case: dropping 방산·드론·희토류 modifiers."""
    result = check_completeness(
        claim="중국 정부가 미국 방산·드론·희토류 관련 기업에 대한 추가 제재에 나섰다.",
        subject="중국",
        predicate="제재",
        object_text="추가 제재",
    )
    assert result["complete"] is False
    assert result["coverage"] < 0.7
    missing = set(result["missing"])  # type: ignore[arg-type]
    # The middle-dot-separated modifiers must each be detected as missing
    assert "방산" in missing or "드론" in missing or "희토류" in missing
    assert "미국" in missing


# ---------------------------------------------------------------------------
# 4 — English path (control)
# ---------------------------------------------------------------------------


def test_english_good_decomp_passes() -> None:
    """English claim + English SPO covers all content tokens."""
    result = check_completeness(
        claim="China added 10 US firms to export control list.",
        subject="China",
        predicate="added to export control list",
        object_text="10 US firms",
    )
    assert result["complete"] is True
    # Coverage should be ~1.0 (allow tiny slack — the/to/etc are stoplisted)
    assert result["coverage"] >= 0.9


# ---------------------------------------------------------------------------
# 5-6 — Edge cases
# ---------------------------------------------------------------------------


def test_empty_claim_is_vacuously_complete() -> None:
    """An empty claim has nothing to cover — always complete."""
    result = check_completeness(
        claim="",
        subject="중국",
        predicate="올렸다",
        object_text="10곳",
    )
    assert result["complete"] is True
    assert result["coverage"] == 1.0
    assert result["reason"] == "empty_claim"


def test_empty_predicate_drops_coverage() -> None:
    """When predicate is missing, the verb token(s) won't be covered."""
    result = check_completeness(
        claim="중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        subject="중국 정부",
        predicate="",
        object_text="미국 기업",
    )
    # Missing 올렸다 / 수출통제 / 대상 / 10곳 — likely fails
    assert result["complete"] is False
    missing = set(result["missing"])  # type: ignore[arg-type]
    assert "올렸다" in missing


# ---------------------------------------------------------------------------
# 7 — Korean particle stripping
# ---------------------------------------------------------------------------


def test_korean_particles_are_stripped() -> None:
    """'중국이' in claim and '중국' in subject must be treated as the
    same content token (particle 이 stripped).
    """
    # Claim ends with particle '이가' / '을'; SPO uses bare nouns.
    result = check_completeness(
        claim="중국이 발표했다.",
        subject="중국",
        predicate="발표했다",
        object_text="",
    )
    assert result["complete"] is True
    assert result["coverage"] == 1.0


# ---------------------------------------------------------------------------
# 8 — Multi-word noun phrases preserved across middle-dots
# ---------------------------------------------------------------------------


def test_middle_dot_separates_compound_modifiers() -> None:
    """방산·드론·희토류 must tokenize into 3 distinct tokens, NOT one
    joined blob. Otherwise PO's bad-decomp coverage skew is wrong.
    """
    tokens = _tokenize("방산·드론·희토류 관련 기업")
    # Each middle-dot-separated noun is a token
    assert "방산" in tokens
    assert "드론" in tokens
    assert "희토류" in tokens
    assert "관련" in tokens
    assert "기업" in tokens


# ---------------------------------------------------------------------------
# 9 — Threshold tuning
# ---------------------------------------------------------------------------


def test_coverage_threshold_is_respected() -> None:
    """Lowering threshold to 0.3 should let the bad-decomp PASS (since
    coverage is 0.375). Raising to 0.5 must still FAIL it.
    """
    args = dict(
        claim="중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        subject="중국",
        predicate="올렸다",
        object_text="10곳",
    )
    loose = check_completeness(**args, coverage_threshold=0.3)
    tight = check_completeness(**args, coverage_threshold=0.5)
    # Coverage is ~0.375; loose passes, tight fails.
    assert loose["complete"] is True
    assert tight["complete"] is False


# ---------------------------------------------------------------------------
# 10 — Common stopwords ignored
# ---------------------------------------------------------------------------


def test_common_stopwords_dont_inflate_missing_set() -> None:
    """English 'a' / 'the' / 'of' must not be flagged as missing.

    Claim has 'the' twice; SPO omits both — should still pass with
    100% coverage.
    """
    result = check_completeness(
        claim="The CEO announced the product.",
        subject="CEO",
        predicate="announced",
        object_text="product",
    )
    assert result["complete"] is True
    missing = result["missing"]
    # 'the' must NOT appear in missing
    assert "the" not in missing
