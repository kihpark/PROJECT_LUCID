"""Unit tests for deterministic Korean subject recovery (B-62-fix-v6).

PO 2026-06-22 ★ acceptance cases for feat/spo-subject-claim-recovery.
The recovery parses the claim text using Korean particle boundaries —
no LLM, no dictionary, no translation. Each test pins one specific
parsing behavior.
"""
from __future__ import annotations

from api.structure.subject_recovery import recover_korean_subject_from_claim

# ─── ★ PO ACCEPTANCE CASES ────────────────────────────────────────────


def test_japan_topic_particle() -> None:
    """일본은... → 일본 (the PR's primary acceptance case)."""
    claim = "일본은 무기 수출 규제를 완화하며 외교적 영향력을 강화했다."
    assert recover_korean_subject_from_claim(claim) == "일본"


def test_ministry_topic_particle() -> None:
    """중국 상무부는... → 중국 상무부."""
    claim = "중국 상무부는 미국 반도체 수출통제에 대응했다."
    assert recover_korean_subject_from_claim(claim) == "중국 상무부"


def test_leading_time_adverbial_excluded() -> None:
    """22일 중국 상무부는... → 중국 상무부 (NOT 22일 중국 상무부)."""
    claim = "22일 중국 상무부는 발표했다."
    assert recover_korean_subject_from_claim(claim) == "중국 상무부"


def test_compound_person_name_with_title() -> None:
    """안도걸 더불어민주당 의원은... → 안도걸 더불어민주당 의원."""
    claim = "안도걸 더불어민주당 의원은 청문회에서 발언했다."
    assert recover_korean_subject_from_claim(claim) == "안도걸 더불어민주당 의원"


def test_subject_particle_ga() -> None:
    """에이비옥스가... → 에이비옥스."""
    claim = "에이비옥스가 거래 종목에 포함되었다."
    assert recover_korean_subject_from_claim(claim) == "에이비옥스"


def test_finance_ministry() -> None:
    """중국 재정부는... → 중국 재정부."""
    claim = "중국 재정부는 수출 환급 정책을 조정했다."
    assert recover_korean_subject_from_claim(claim) == "중국 재정부"


# ─── EXTENDED EDGE CASES ───────────────────────────────────────────────


def test_subject_particle_yi() -> None:
    """안철수가 → 안철수 (의/이 final consonant gives subject particle 가)."""
    claim = "안철수가 발표했다."
    assert recover_korean_subject_from_claim(claim) == "안철수"


def test_subject_particle_i_after_consonant() -> None:
    """김민준이 → 김민준 ('이' subject particle after final consonant)."""
    claim = "김민준이 회의를 진행했다."
    assert recover_korean_subject_from_claim(claim) == "김민준"


def test_honorific_particle_kkeseo() -> None:
    """대통령께서 → 대통령 (honorific subject particle)."""
    claim = "대통령께서 회의를 주재하셨다."
    assert recover_korean_subject_from_claim(claim) == "대통령"


def test_institutional_eseo() -> None:
    """정부에서 → 정부 (institutional subject particle)."""
    claim = "정부에서 새 정책을 발표했다."
    assert recover_korean_subject_from_claim(claim) == "정부"


def test_recovery_when_only_english_claim() -> None:
    """English-only claim → None (no Korean subject to recover)."""
    claim = "Japan announced a new export policy."
    assert recover_korean_subject_from_claim(claim) is None


def test_recovery_when_no_particle() -> None:
    """No subject particle anywhere → None."""
    claim = "일본 무기 수출 규제 완화."
    assert recover_korean_subject_from_claim(claim) is None


def test_recovery_handles_multiple_particles_picks_first() -> None:
    """First particle wins — main clause subject is leftmost agent."""
    claim = "일본은 발표했고 미국은 응답했다."
    assert recover_korean_subject_from_claim(claim) == "일본"


def test_recovery_strips_leading_temporal_complex() -> None:
    """지난 12일 한국은행은... → 한국은행."""
    claim = "지난 12일 한국은행은 기준금리를 인상했다."
    assert recover_korean_subject_from_claim(claim) == "한국은행"


def test_recovery_strips_month_day() -> None:
    """11월 22일 정부는... → 정부."""
    claim = "11월 22일 정부는 새 규제를 발표했다."
    assert recover_korean_subject_from_claim(claim) == "정부"


def test_recovery_empty_input() -> None:
    """Empty / None inputs → None."""
    assert recover_korean_subject_from_claim("") is None
    assert recover_korean_subject_from_claim(None) is None  # type: ignore[arg-type]


def test_recovery_keeps_korean_with_interpunct() -> None:
    """Compound noun with interpunct between Korean parts is preserved."""
    # 서울대·서울시가 (all-Korean compound with interpunct) → 서울대·서울시.
    # The interpunct (·) is in our noun-char regex.
    claim = "서울대·서울시가 공동 사업을 발표했다."
    assert recover_korean_subject_from_claim(claim) == "서울대·서울시"


def test_recovery_skips_particle_at_start() -> None:
    """Particle at the very start (no preceding noun) is not a match."""
    # Pathological: "은" at position 0 has no noun before it.
    claim = "은행이 발표했다."
    # Should recover "은행" (이 particle, preceded by 행 which is a noun char)
    assert recover_korean_subject_from_claim(claim) == "은행"


def test_recovery_object_value_inside_claim_not_picked() -> None:
    """The object's particle (을/를) is NOT a subject particle.

    "중국이 미국을 비판했다" → 중국 (subject), NOT 미국 (object).
    """
    claim = "중국이 미국을 비판했다."
    assert recover_korean_subject_from_claim(claim) == "중국"
