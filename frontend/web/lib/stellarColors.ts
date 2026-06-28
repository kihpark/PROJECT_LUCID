/**
 * M3-2b STELLAR 시각 어휘 (PO 2026-06-28 정정 spec 반영).
 *
 * ★ 점선 폐기: 모든 fact (action/claim/measurement) = 실선.
 *   "누가 무엇을 주장했다" 도 검증된 fact. 점선·미검증·흐림 개념 0.
 *
 * 구분 = "행위 vs 발화" 성격 → 색·스타일로만.
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

/** Entity-type-keyed color palette. Unknown types fall back to STELLAR_ACCENT. */
export const ENTITY_COLORS = {
  person: '#5EEAD4',        // WHO
  organization: '#5EEAD4',  // WHO
  group: '#5EEAD4',         // WHO
  product: '#F5C36B',       // WHAT
  resource: '#F5C36B',      // WHAT
  concept: '#F5C36B',       // WHAT
  knowledge: '#F5C36B',     // WHAT
  event: '#A78BFA',         // WHAT-EVENT
  place: '#7A8CA3',         // WHERE
} as const;

export type EntityColorKey = keyof typeof ENTITY_COLORS;

/** CLAIM 노드 전용 색. ★ PO 정정: opacity 1 (흐림 금지). */
export const CLAIM_NODE_COLOR = '#5EEAD4';

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
