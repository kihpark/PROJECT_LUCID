"""feat/measurement-completeness — unit tests for check_measurement_completeness.

Live PO evidence (2026-06-24):
  claim: "노사 양측의 최초 요구안 차이는 시급 기준 1680원이다."
  bad   : metric="최초 요구안 차이", value=1680, unit="원", as_of="2027"
  good  : metric="노사 양측의 최초 요구안 차이 (시급 기준)",
          value=1680, unit="원", as_of=None, entity="노사 양측"

The validator must:
  - PASS the GOOD quadruple (≥0.7 coverage).
  - FAIL the BAD quadruple (low coverage, polluted as_of, thin metric).
  - Vacuously PASS when claim is empty.
  - Respect the coverage_threshold parameter.
  - Surface missing tokens for HITL.
  - Include entity_label in the quadruple text.
  - Handle integer-valued floats (1680.0 → "1680" token).
"""
from __future__ import annotations

from api.structure.completeness_validator import (
    check_measurement_completeness,
)


def test_rich_metric_with_null_as_of_passes() -> None:
    """PO's 노사 case — GOOD quadruple. metric carries 主체 + 기준
    qualifiers; as_of is correctly null (application-time, not measurement
    time); entity_label is the subject. Coverage ≥ 0.7 → complete.
    """
    result = check_measurement_completeness(
        claim="노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.",
        metric="노사 양측의 최초 요구안 차이 (시급 기준)",
        measurement_value=1680.0,
        measurement_unit="원",
        as_of=None,
        entity_label="노사 양측",
    )
    assert result["complete"] is True
    assert result["coverage"] >= 0.7
    assert result["reason"] == "ok"


def test_thin_metric_with_polluted_as_of_fails() -> None:
    """PO's 노사 case — BAD quadruple. metric is the thin "최초 요구안
    차이", losing 주체 + 기준; as_of incorrectly carries the application
    time "2027". Coverage below threshold → flagged for HITL.
    """
    result = check_measurement_completeness(
        claim="노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.",
        metric="최초 요구안 차이",
        measurement_value=1680.0,
        measurement_unit="원",
        as_of="2027",
        entity_label=None,
    )
    assert result["complete"] is False
    # The dropped qualifier tokens land in `missing`.
    missing = set(result["missing"])  # type: ignore[arg-type]
    # 노사 / 양측 / 시급 / 기준 are the qualifiers the LLM dropped.
    # At least the 主체 (노사 / 양측) and 기준 (시급) must surface.
    assert "노사" in missing
    assert "양측" in missing
    assert "시급" in missing


def test_chatgpt_mau_case_richness_improves_coverage() -> None:
    """The MAU anchor — demonstrates that the validator rewards
    qualifier-rich metric strings. A bare 'MAU' loses 5 tokens (the 主体
    qualifier 'ChatGPT' is recovered via entity_label, but the temporal
    qualifiers '2026년 3월 기준' are dropped). A richer metric that
    rolls the temporal context in covers more of the claim.

    The tokenizer keeps '2026년' and '3월' as separate content tokens
    distinct from the as_of '2026-03' format — that is expected behavior:
    the validator measures coverage of the claim's surface tokens, not
    semantic equivalence. A faithful metric should mirror the surface.
    """
    args = dict(
        claim="ChatGPT 의 MAU 는 2026년 3월 기준 8억 명이다.",
        measurement_value=800000000,
        measurement_unit="명",
        as_of="2026-03",
        entity_label="ChatGPT",
    )
    thin = check_measurement_completeness(metric="MAU", **args)
    rich = check_measurement_completeness(
        metric="ChatGPT 의 2026년 3월 월간 활성 사용자 (MAU)", **args,
    )
    # Richer metric MUST cover more (or at least the same)
    assert float(rich["coverage"]) > float(thin["coverage"])


def test_empty_claim_is_vacuously_complete() -> None:
    """Empty claim → nothing to cover → vacuously complete."""
    result = check_measurement_completeness(
        claim="",
        metric="MAU",
        measurement_value=800000000,
        measurement_unit="명",
        as_of="2026-03",
    )
    assert result["complete"] is True
    assert result["coverage"] == 1.0
    assert result["reason"] == "empty_claim"


def test_threshold_parameter_respected() -> None:
    """A loose threshold passes the BAD case; a tight threshold fails
    the GOOD case. The validator must respect coverage_threshold the
    same way `check_completeness` does.
    """
    bad = check_measurement_completeness(
        claim="노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.",
        metric="최초 요구안 차이",
        measurement_value=1680.0,
        measurement_unit="원",
        as_of="2027",
        coverage_threshold=0.2,  # very loose
    )
    # Coverage on the bad case sits in the 0.3 region — passes at 0.2.
    assert bad["complete"] is True

    good = check_measurement_completeness(
        claim="노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.",
        metric="노사 양측의 최초 요구안 차이 (시급 기준)",
        measurement_value=1680.0,
        measurement_unit="원",
        as_of=None,
        entity_label="노사 양측",
        coverage_threshold=1.01,  # impossible
    )
    assert good["complete"] is False


def test_missing_tokens_surfaced_for_hitl() -> None:
    """When coverage fails, `missing` carries the dropped tokens so the
    Decide overlay can highlight what HITL must fix.
    """
    result = check_measurement_completeness(
        claim="삼성전자의 2026년 1분기 매출은 70조 원이었다.",
        metric="매출",  # 주체 + 기간 both dropped
        measurement_value=70,
        measurement_unit="조 원",
        as_of=None,
        entity_label=None,
    )
    assert result["complete"] is False
    missing = set(result["missing"])  # type: ignore[arg-type]
    # 삼성전자 + 2026년 + 1분기 are the missing qualifiers.
    assert "삼성전자" in missing
    # Also at least one period anchor — 2026 or 1분기 (the tokenizer
    # may keep "2026년" together or strip the suffix particle).
    assert any(t in missing for t in ("2026년", "2026", "1분기"))


def test_entity_label_included_in_coverage() -> None:
    """When the metric is thin but entity_label carries the subject
    qualifier, the quad text grows to include the entity. Same article
    as the SAMSUNG case above but with entity_label=삼성전자 — coverage
    is higher than without.
    """
    args = dict(
        claim="삼성전자의 2026년 1분기 매출은 70조 원이었다.",
        metric="2026년 1분기 매출",
        measurement_value=70,
        measurement_unit="조 원",
        as_of="2026-Q1",
    )
    no_entity = check_measurement_completeness(**args, entity_label=None)
    with_entity = check_measurement_completeness(**args, entity_label="삼성전자")
    # entity_label adds 삼성전자 to the quad → coverage must go up
    # (or at least not down). Strict > so the assertion has bite.
    assert float(with_entity["coverage"]) > float(no_entity["coverage"])


def test_integer_valued_float_renders_as_int_token() -> None:
    """measurement_value=1680.0 must render as token "1680" to match the
    claim's "1680원" → ("1680", "원") after particle/punct strip. If we
    accidentally rendered "1680.0", the token wouldn't match.
    """
    result = check_measurement_completeness(
        claim="시급은 1680원이다.",
        metric="시급",
        measurement_value=1680.0,
        measurement_unit="원",
        as_of=None,
    )
    # The "1680" token should not appear in `missing` — value rendering OK.
    missing = set(result["missing"])  # type: ignore[arg-type]
    assert "1680" not in missing
    assert "1680.0" not in missing
