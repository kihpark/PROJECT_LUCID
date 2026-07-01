/**
 * M3-2b STELLAR 시각 어휘 (PO 2026-06-28 정정 spec 반영).
 *
 * ★ 점선 폐기: 모든 fact (action/claim/measurement) = 실선.
 *   "누가 무엇을 주장했다" 도 검증된 fact. 점선·미검증·흐림 개념 0.
 *
 * 구분 = "행위 vs 발언" 성격 → 색·스타일로만.
 *
 * ★ REQ-013 (PO 2026-07-02) — 색상 재설계 (recurring issue).
 *   옛 amber family (WHAT 6 소분류) 는 명도만으로는 시각 구분이 약해
 *   resource / knowledge / task 가 사용자에게 혼동됨. WHERE 도 slate/blue-
 *   gray 라 background 대비 낮았음. 10 entity_type + claim + unknown 조합이
 *   전부 한눈에 갈리도록 상보 색상 (complementary/distinct hues) 로 재배정.
 *
 *   Mapping (REQ-013):
 *     person       → teal      '#5EEAD4'  (WHO — 유지)
 *     organization → cyan      '#22D3EE'  (WHO — 유지)
 *     group        → lime      '#A3E635'  (WHO — 유지)
 *     resource     → orange    '#F97316'  (WHAT — 옛 amber-300 → 밝은 오렌지)
 *     concept      → purple    '#A855F7'  (WHAT — 옛 amber-400 → 보라)
 *     task         → rose      '#F43F5E'  (WHAT — 옛 amber-500 → 로즈)
 *     knowledge    → cyan-blue '#06B6D4'  (WHAT — 옛 amber-600 → 시안블루)
 *     event        → violet    '#8B5CF6'  (WHAT — 옛 amber-700 → 바이올렛)
 *     metric       → emerald   '#10B981'  (WHAT — 옛 amber-800 → 에메랄드)
 *     place        → red       '#EF4444'  (WHERE — 옛 slate → 빨강)
 *     CLAIM        → gray      '#6B7280'  (모든 entity 와 시각 구분)
 *     UNKNOWN      → stone     '#78716C'  (CLAIM 과 구분 — see stellarLegendShapes)
 */

/** Entity-type-keyed color palette. Unknown types fall back to STELLAR_ACCENT.
 *  ★ REQ-013 (PO 2026-07-02): amber/slate 폐기, 10 hue 상보 재배정.
 *  같은 luminance 대에서 hue 를 서로 다른 지대로 배치 → color-blind safe
 *  channel 은 stellarShapes 형태 6종 가 별도 담당. */
export const ENTITY_COLORS = {
  person: '#5EEAD4',        // WHO · person       (teal)
  organization: '#22D3EE',  // WHO · organization (cyan)
  group: '#A3E635',         // WHO · group        (lime)
  // WHAT — 6 소분류, 각기 다른 hue 로 재배정 (REQ-013 PO 2026-07-02).
  resource: '#F97316',      // WHAT · 자원 (orange, 옛 amber-300)
  product: '#F97316',       // WHAT · 자원 alias
  concept: '#A855F7',       // WHAT · 개념 (purple, 옛 amber-400)
  task: '#F43F5E',          // WHAT · 행위 (rose, 옛 amber-500)
  procedure: '#F43F5E',     // WHAT · 행위 alias
  service: '#F43F5E',       // WHAT · 행위 alias
  problem: '#F43F5E',       // WHAT · 행위 alias
  knowledge: '#06B6D4',     // WHAT · 지식 (cyan-blue, 옛 amber-600)
  event: '#8B5CF6',         // WHAT · 사건 (violet, 옛 amber-700)
  artifact: '#8B5CF6',      // WHAT · 사건 alias
  metric: '#10B981',        // WHAT · 지표 (emerald, 옛 amber-800)
  place: '#EF4444',         // WHERE      (red, 옛 slate)
  location: '#EF4444',      // WHERE alias
  region: '#EF4444',        // WHERE alias
  venue: '#EF4444',         // WHERE alias
} as const;

export type EntityColorKey = keyof typeof ENTITY_COLORS;

/** CLAIM 노드 전용 색. ★ PO 정정: opacity 1 (흐림 금지).
 *  ★ REQ-013 (PO 2026-07-02): 옛 '#CBD5E1' 은 밝은 회색이라 lime/teal 과 luminance
 *  가 비슷해 시각 충돌. neutral mid-gray '#6B7280' 로 조정 → 모든 entity hue
 *  와 명확히 구분되면서 unknown '#78716C' (stone) 과도 갈린다. */
export const CLAIM_NODE_COLOR = '#6B7280';

/** CLAIM 노드 opacity. ★ 무조건 1. */
export const CLAIM_NODE_OPACITY = 1;

/** Default accent for unknown entity types. */
export const STELLAR_ACCENT = '#5EEAD4';

/** Lookup helper. Returns STELLAR_ACCENT for unknown/null inputs. */
export function colorForEntityType(entityType: string | null | undefined): string {
  if (!entityType) return STELLAR_ACCENT;
  const key = entityType.toLowerCase() as EntityColorKey;
  return ENTITY_COLORS[key] ?? STELLAR_ACCENT;
}
