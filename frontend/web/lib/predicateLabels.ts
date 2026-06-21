/**
 * B-56 — predicate Korean display labels.
 *
 * The English snake_case predicate is the canonical KEY everywhere
 * downstream: ES storage, facet bucket keys, graph adjacency, the
 * recall API response model. We never mutate it.
 *
 * This module is the DISPLAY layer only — it maps a curated set of
 * predicates to a Korean reading-friendly label. Any predicate not in
 * the map falls back to its canonical English string so an uncovered
 * value renders verbatim (never empty, never a crash).
 *
 * The curated seed below was derived from the B-56 live cardinality
 * diagnosis (55 distinct predicates in lucid_facts; long tail of
 * count=1). The covered set targets the head of that distribution
 * plus a few high-signal predicates the user surfaces routinely.
 * To extend coverage, just add an entry — there is no schema, no
 * registration, no backend touch.
 */

export interface PredicateLabelEntry {
  ko: string;
  description?: string;
}

export const PREDICATE_LABELS: Record<string, PredicateLabelEntry> = {
  // --- Top of the live diagnosis (head of distribution) ---
  operates: { ko: '운영하는 것은' },
  trading_value: { ko: '총 거래 대금은' },
  is_examining: { ko: '검토 중인 것은' },
  secured_allocation: { ko: '확보한 배정은' },

  // --- Funding / capital markets (recurring in the corpus) ---
  raised_initial_funding: { ko: '초기 조달 자금은' },
  total_funding_raised: { ko: '총 조달 자금은' },
  set_ipo_price: { ko: '공모가를' },
  ipo_price_per_share: { ko: '주당 공모가는' },
  final_shares_issued: { ko: '최종 발행주식 수는' },
  held_option_for: { ko: '보유 옵션은' },
  exercised: { ko: '행사한 권리는' },
  is_underwriter_for: { ko: '주관사로 참여한 곳은' },
  stock_price_increase: { ko: '주가 상승률은' },
  allocation_value: { ko: '배정 금액은' },
  allocation_received: { ko: '배정 받은 것은' },
  allocation_status: { ko: '배정 상태는' },
  allocated_shares_to: { ko: '주식을 배정한 대상은' },
  initial_free_float_ratio: { ko: '초기 유통 비율은' },
  net_buying_value: { ko: '순매수 금액은' },
  net_retail_purchases: { ko: '개인 순매수는' },
  cumulative_inflows: { ko: '누적 유입은' },
  ipo_allocation_target: { ko: '공모 배정 대상은' },
  ipo_subscription_access: { ko: '공모주 청약 자격은' },
  purchased: { ko: '매수한 것은' },
  purchased_at_premium: { ko: '프리미엄에 매수한 것은' },
  charged_fee: { ko: '부과한 수수료는' },
  can_add_stock_timing: { ko: '추가 매수 가능 시점은' },
  plans_to_add_shares_to: { ko: '추가 매수 예정은' },

  // --- Regulatory / examination context ---
  decided_to_remove: { ko: '철거하기로 결정한 것은' },
  lifts_protection_on: { ko: '보호 해제 대상은' },
  plans_to_transition_to: { ko: '전환 계획은' },
  states_reason: { ko: '사유로 제시한 것은' },
  stated_unrelated_to: { ko: '무관하다고 밝힌 것은' },
  examination_covers: { ko: '검토 범위는' },
  escalated_inspection_to: { ko: '점검을 격상한 단계는' },
  regulatory_assessment: { ko: '규제 평가는' },
  regulatory_cap: { ko: '규제 상한은' },
  exempts_from: { ko: '면제 대상은' },
  triggered: { ko: '촉발한 것은' },
  might_occur_if: { ko: '발생 조건은' },

  // --- Entities, structural relations ---
  is_a: { ko: '분류는' },
  located_in: { ko: '소재지는' },
  works_at: { ko: '근무지는' },
  leads: { ko: '이끄는 것은' },
  conducted: { ko: '수행한 것은' },
  allows: { ko: '허용하는 것은' },
  offers_feature: { ko: '제공 기능은' },
  promoted_as: { ko: '홍보한 내용은' },
  employees_visit: { ko: '직원이 방문한 곳은' },
  received_complaints_from: { ko: '민원이 접수된 곳은' },
  expressed_expectations_of: { ko: '기대 대상은' },
  relocated_from_to: { ko: '이전 구간은' },
  listing_date: { ko: '상장일은' },
  price: { ko: '가격은' },
  purpose_is: { ko: '목적은' },

  // --- Additional commonly-seen predicates outside top-cardinality ---
  base_rate_value: { ko: '기준금리는' },
  base_rate: { ko: '기준금리는' },
  founded_year: { ko: '설립 연도는' },
  operating_profit: { ko: '영업이익은' },
  transition_to: { ko: '전환 상태는' },
  profit_change: { ko: '이익 변동은' },
};

/**
 * Return the display label for a canonical predicate.
 *
 * Contract (B-62 natural-spo-display):
 *   - If `predicate_label` is a non-empty string, return it verbatim.
 *     This is the server-resolved natural-English gloss from the OPL
 *     pipeline and wins over the static seed below.
 *   - Else if `canonicalOrLabel` is in PREDICATE_LABELS, return its
 *     `ko` label (curated Korean reading-friendly text).
 *   - Otherwise, return the input string unchanged (fallback).
 *   - Empty string in → empty string out (never throws).
 */
export function predicateLabel(
  canonicalOrLabel: string,
  predicate_label?: string | null,
): string {
  if (typeof predicate_label === 'string' && predicate_label.length > 0) {
    return predicate_label;
  }
  return PREDICATE_LABELS[canonicalOrLabel]?.ko ?? canonicalOrLabel;
}
