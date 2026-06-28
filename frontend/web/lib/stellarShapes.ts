/**
 * M3-2b STELLAR 형태 어휘 (PO 2026-06-28 정정).
 *
 * 색맹 안전 보조 채널: 같은 색이라도 형태로 구분 가능해야 한다.
 *   WHO         → circle (원)
 *   WHAT        → roundedSquare (둥근사각)
 *   WHAT-EVENT  → diamond (마름모)
 *   WHERE       → pin (핀)
 *   CLAIM       → dot (작은 점) — ★ 단 또렷 (흐림 X)
 *
 * 순수 문자열 enum: SVG / canvas / three.js sprite 셋 모두에서 분기 가능.
 */

export type StellarShape =
  | 'circle'
  | 'roundedSquare'
  | 'diamond'
  | 'pin'
  | 'dot';

/** Entity-type vocabulary used by both the shape and color maps. Aligns with
 *  the backend entity.type enum. */
export const ENTITY_SHAPES: Record<string, StellarShape> = {
  person: 'circle',
  organization: 'circle',
  group: 'circle',
  product: 'roundedSquare',
  resource: 'roundedSquare',
  concept: 'roundedSquare',
  knowledge: 'roundedSquare',
  event: 'diamond',
  place: 'pin',
};

/** Default shape for unknown entity types — same as WHO so unresolved nodes
 *  still read as "an entity". */
export const DEFAULT_SHAPE: StellarShape = 'circle';

/** Shape used by CLAIM nodes. ★ 작은 점, 단 또렷 (opacity 1). */
export const CLAIM_SHAPE: StellarShape = 'dot';

/** Lookup helper. Returns DEFAULT_SHAPE for unknown / null inputs. */
export function shapeForEntityType(entityType: string | null | undefined): StellarShape {
  if (!entityType) return DEFAULT_SHAPE;
  return ENTITY_SHAPES[entityType.toLowerCase()] ?? DEFAULT_SHAPE;
}
