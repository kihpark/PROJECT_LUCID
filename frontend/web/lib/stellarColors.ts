/**
 * M3-2b STELLAR 시각 어휘 (PO 2026-06-28 정정 spec 반영).
 *
 * ★ 점선 폐기: 모든 fact (action/claim/measurement) = 실선.
 *   "누가 무엇을 주장했다" 도 검증된 fact. 점선·미검증·흐림 개념 0.
 *
 * 구분 = "행위 vs 발언" 성격 → 색·스타일로만.
 *
 * Mapping table (entity type → display color):
 *   WHO    — person / organization / group               → teal/cyan
 *   WHAT   — product / resource / concept / knowledge    → amber/gold
 *   EVENT  — event                                       → violet
 *   WHERE  — place                                       → slate/blue-gray
 *   CLAIM  — claim node (작게, 단 또렷)                  → same teal, opacity 1
 *
 * ★ CLAIM 노드는 크기로만 보조 표시 (작은 점), 색·opacity 는 또렷 유지.
 *   PO 정정 spec: link_status / 미검증 / 흐림 / 점선 시각 강약 폐기.
 */

/** Entity-type-keyed color palette. Unknown types fall back to STELLAR_ACCENT.
 *  ★ L2 (PO 2026-06-29): WHO 묶음 안에서 person / organization / group 의
 *  hue 를 미세하게 분리 — color-blind safe channel 은 stellarShapes 가 담당
 *  하지만, 정상 시각 사용자에게도 색의 미세 차이를 더해 인지 부담을 더 줄인다.
 *    person       → teal       '#5EEAD4'  (선명 teal — 가장 친숙한 톤)
 *    organization → cyan       '#22D3EE'  (약간 청록 쪽, "조직 = 차가운")
 *    group        → teal-lime  '#A3E635'  (lime, "묶음")
 *  세 톤 모두 luminance 비슷하게 유지해 bloom threshold 효과는 동일. */
export const ENTITY_COLORS = {
  person: '#5EEAD4',        // WHO · person
  organization: '#22D3EE',  // WHO · organization (★ L2 — cyan 톤 분리)
  group: '#A3E635',         // WHO · group        (★ L2 — lime 톤 분리)
  product: '#F5C36B',       // WHAT
  resource: '#F5C36B',      // WHAT
  concept: '#F5C36B',       // WHAT
  knowledge: '#F5C36B',     // WHAT
  event: '#A78BFA',         // WHAT-EVENT
  place: '#7A8CA3',         // WHERE
} as const;

export type EntityColorKey = keyof typeof ENTITY_COLORS;

/** CLAIM 노드 전용 색. ★ PO 정정: opacity 1 (흐림 금지).
 *  ★ 2026-06-29 PO: entity 노드 와 시각 구분 필요 — 옛 #5EEAD4 (teal) =
 *  WHO entity 색과 충돌. neutral cool grey 로 분리 (★ "발언" = 채도 0,
 *  entity = colorful hue). */
export const CLAIM_NODE_COLOR = '#CBD5E1';

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
