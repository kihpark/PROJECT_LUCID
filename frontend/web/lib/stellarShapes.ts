/**
 * M3-2b STELLAR 형태 어휘 (PO 2026-06-28 정정 + 2026-06-29 L2 확장).
 *
 * 색맹 안전 보조 채널: 같은 색이라도 형태로 구분 가능해야 한다.
 *
 * ★ L2 (PO 2026-06-29): WHO 묶음 안에서 person / organization / group 모두
 *   같은 teal '#5EEAD4' + circle 이라 사용자가 사람과 조직을 시각적으로
 *   구분할 수 없었다. 형태를 1차 채널로 분리:
 *     person       → sphere        (구, 사람 = 둥근 머리 metaphor)
 *     organization → cube          (각진 박스, 조직의 단단함 metaphor)
 *     group        → diamond       (마름모, 묶음 metaphor)
 *     event        → roundedSquare (둥근사각, 사건)
 *     place        → pin           (핀, 장소 표지)
 *     product/concept/knowledge → sphere (WHAT 묶음 default)
 *     claim        → dot           (작은 점, 또렷)
 *
 * 순수 문자열 enum: SVG / canvas / three.js sprite 셋 모두에서 분기 가능.
 */

export type StellarShape =
  | 'sphere'
  | 'circle'
  | 'roundedSquare'
  | 'cube'
  | 'diamond'
  | 'pin'
  | 'dot';

/** Entity-type vocabulary used by both the shape and color maps. Aligns with
 *  the backend entity.type enum. ★ L2 (2026-06-29): person/organization/group
 *  는 각자 다른 형태를 받는다 — WHO 안의 시각 구분. */
export const ENTITY_SHAPES: Record<string, StellarShape> = {
  // WHO — 형태로 1차 구분 (★ L2 fix).
  person: 'sphere',
  organization: 'cube',
  group: 'diamond',
  // WHAT — 같은 묶음이므로 default sphere 공유.
  product: 'sphere',
  resource: 'sphere',
  concept: 'sphere',
  knowledge: 'sphere',
  // EVENT — 둥근사각.
  event: 'roundedSquare',
  artifact: 'roundedSquare',
  // WHERE — pin.
  place: 'pin',
  location: 'pin',
  region: 'pin',
  venue: 'pin',
};

/** Default shape for unknown entity types — same as WHO so unresolved nodes
 *  still read as "an entity". */
export const DEFAULT_SHAPE: StellarShape = 'sphere';

/** Shape used by CLAIM nodes. ★ 작은 점, 단 또렷 (opacity 1). */
export const CLAIM_SHAPE: StellarShape = 'dot';

/** Lookup helper. Returns DEFAULT_SHAPE for unknown / null inputs. */
export function shapeForEntityType(entityType: string | null | undefined): StellarShape {
  if (!entityType) return DEFAULT_SHAPE;
  return ENTITY_SHAPES[entityType.toLowerCase()] ?? DEFAULT_SHAPE;
}

/** ★ L2 (PO 2026-06-29) — UI-friendly KR label for a shape. Used by the
 *  StellarLegend swatch so the legend reads "● 사람 / ■ 조직 / ◆ 그룹". */
export const SHAPE_LABEL: Record<StellarShape, string> = {
  sphere: '●',
  circle: '●',
  roundedSquare: '▢',
  cube: '■',
  diamond: '◆',
  pin: '📍',
  dot: '•',
};
