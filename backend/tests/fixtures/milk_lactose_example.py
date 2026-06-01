"""Beta-시연용 우유 / 유당 / A1 / A2 베타카제인 fixture.

Used by `test_e2e_milk_lactose_complete_flow` to validate that the
Structure stage decomposes a real-world Korean three-statement
transcript into the expected fact/object/link skeleton with the
expected negation flags.

The fixture is a ground-truth target, not the literal expected output
of Claude. The test compares aggregate shape (fact count, negation flag
distribution, link type counts) and accepts a 90% match threshold rather
than exact strings.
"""
from __future__ import annotations

from typing import Any

# ----------------------------------------------------------------------
# Source transcript (three statements concatenated)
# ----------------------------------------------------------------------
TRANSCRIPT = (
    "우유에 있는 탄수화물인 유당은 동아시아인의 70~90% 성인은 이걸 "
    "분해하는 효소가 거의 없습니다. 그래서 우유를 마시면 장이 손상되고 "
    "염증 반응이 일어날 수 있습니다. 베타카제인 A1은 몸에 들어왔을 때 "
    "장에서 소화가 제대로 되지 않기 때문에 면역 반응을 유발할 수 있다고 "
    "알려져 있습니다. 그래서 요즘은 유당을 제거한 락토프리 우유, A1 대신 "
    "A2 베타카제인이 들어 있는 A2 밀크가 따로 나오고 있습니다."
)

# ----------------------------------------------------------------------
# Expected facts (9)
#   - fn-301: 동아시아인 성인 70-90%는 락타아제 효소가 거의 없다  (negation_flag=True, partial)
#   - fn-302: 우유를 마시면 장이 손상된다
#   - fn-303: 우유를 마시면 염증 반응이 일어난다
#   - fn-304: 베타카제인 A1은 장에서 소화가 제대로 안 된다  (negation_flag=True, partial)
#   - fn-305: 베타카제인 A1은 면역 반응을 유발할 수 있다
#   - fn-306: 락토프리 우유는 유당을 제거했다
#   - fn-307: A2 밀크는 A1 대신 A2 베타카제인을 포함한다
#   - fn-308: 우유는 탄수화물인 유당을 포함한다
#   - fn-309: 베타카제인 A1과 A2는 우유의 단백질이다
# ----------------------------------------------------------------------
EXPECTED_FACT_COUNT: int = 9
EXPECTED_NEGATION_FLAG_FACT_UIDS: set[str] = {"fn-301", "fn-304"}
EXPECTED_NEGATION_FLAG_COUNT: int = 2

# ----------------------------------------------------------------------
# Expected objects by class (13 total)
# ----------------------------------------------------------------------
EXPECTED_OBJECTS_BY_CLASS: dict[str, list[str]] = {
    "concept": [
        "유당",
        "락타아제 효소",
        "동아시아인",
        "베타카제인 A1",
        "베타카제인 A2",
    ],
    "product": [
        "락토프리 우유",
        "A2 밀크",
    ],
    "resource": [
        "우유",
    ],
    "problem": [
        "장 손상",
        "염증 반응",
        "소화 문제",
        "면역 반응",
    ],
}
EXPECTED_OBJECT_COUNT: int = sum(
    len(v) for v in EXPECTED_OBJECTS_BY_CLASS.values()
)  # 12

# ----------------------------------------------------------------------
# Expected link distribution
# ----------------------------------------------------------------------
EXPECTED_LINK_DISTRIBUTION: dict[str, int] = {
    "supports": 4,           # fn-301 -> fn-303, fn-304 -> fn-305/306/307
    "asserts_property": 1,   # at least one numeric / definitional
    "describes_state": 4,    # fact -> object describing observable state
    "addresses": 4,          # solutions to problems
}
EXPECTED_LINK_COUNT_MIN: int = sum(EXPECTED_LINK_DISTRIBUTION.values())  # 13


# ----------------------------------------------------------------------
# Pass criteria (90%+ aggregate match)
# ----------------------------------------------------------------------
def assess_match(
    actual_fact_count: int,
    actual_object_count: int,
    actual_negation_flag_count: int,
    actual_supports_count: int,
) -> dict[str, Any]:
    """Compute a per-axis ratio + an overall 0..1 score.

    Each axis is clipped to [0, 1.0] by capping at the expected value.
    The overall score is the average across the four axes. The test asserts
    `>= 0.90`."""
    def _ratio(actual: int, expected: int) -> float:
        if expected == 0:
            return 1.0
        return min(actual, expected) / expected

    facts_ratio = _ratio(actual_fact_count, EXPECTED_FACT_COUNT)
    objects_ratio = _ratio(actual_object_count, EXPECTED_OBJECT_COUNT)
    negation_ratio = _ratio(
        actual_negation_flag_count, EXPECTED_NEGATION_FLAG_COUNT
    )
    supports_ratio = _ratio(
        actual_supports_count,
        EXPECTED_LINK_DISTRIBUTION["supports"],
    )
    overall = (facts_ratio + objects_ratio + negation_ratio + supports_ratio) / 4
    return {
        "facts_ratio": facts_ratio,
        "objects_ratio": objects_ratio,
        "negation_ratio": negation_ratio,
        "supports_ratio": supports_ratio,
        "overall": overall,
    }
