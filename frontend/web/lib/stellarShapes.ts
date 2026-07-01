/**
 * M3-2b STELLAR 형태 어휘 (PO 2026-06-28 정정 + 2026-06-29 L2 확장
 *   + ★ 2026-07-01 WHAT 6 소분류 전부 분리).
 *
 * 색맹 안전 보조 채널: 같은 색이라도 형태로 구분 가능해야 한다.
 *
 * ★ L2 (PO 2026-06-29): WHO 묶음 안에서 person / organization / group 모두
 *   같은 teal '#5EEAD4' + circle 이라 사용자가 사람과 조직을 시각적으로
 *   구분할 수 없었다. 형태를 1차 채널로 분리:
 *     person       → sphere        (구, 사람 = 둥근 머리 metaphor)
 *     organization → cube          (각진 박스, 조직의 단단함 metaphor)
 *     group        → diamond       (마름모, 묶음 metaphor)
 *     place        → pin           (핀, 장소 표지)
 *     claim        → dot           (작은 점, 또렷)
 *
 * ★ WHAT 6 소분류 (PO 2026-07-01 verbatim: "자원/개념/행위/지식/사건/지표 전부
 *   구분되게. 일부만 태그 X. 형태·명도·라벨 전부 구분되게"):
 *     resource  → cube           (자원, 각진 박스)
 *     concept   → sphere         (개념, 구 = 추상)
 *     task      → diamond        (행위, 마름모)
 *     knowledge → octahedron     (지식, 팔면체 — cube 회전형 다면체)
 *     event     → roundedSquare  (사건, 둥근사각)
 *     metric    → cone           (지표, 원뿔 — 축·수치 metaphor)
 *
 *   ★ WHAT sub-bucket 의 shape 는 WHO 의 shape 와 겹쳐도 (cube / sphere /
 *   diamond) 색·라벨 채널로 구분된다. PO 명시적으로 amber 색 계열 유지 요구.
 *
 * 순수 문자열 enum: SVG / canvas / three.js sprite 셋 모두에서 분기 가능.
 */

export type StellarShape =
  | 'sphere'
  | 'circle'
  | 'roundedSquare'
  | 'cube'
  | 'diamond'
  | 'octahedron'
  | 'cone'
  | 'pin'
  | 'dot';

/** Entity-type vocabulary used by both the shape and color maps. Aligns with
 *  the backend entity.type enum. ★ L2 (2026-06-29): person/organization/group
 *  는 각자 다른 형태를 받는다 — WHO 안의 시각 구분.
 *  ★ 2026-07-01: WHAT 6 소분류 (resource/concept/task/knowledge/event/metric)
 *  모두 다른 형태 (cube/sphere/diamond/octahedron/roundedSquare/cone). */
export const ENTITY_SHAPES: Record<string, StellarShape> = {
  // WHO — 형태로 1차 구분 (★ L2 fix).
  person: 'sphere',
  organization: 'cube',
  group: 'diamond',
  // WHAT 6 소분류 — 형태 전부 구분 (★ 2026-07-01 PO).
  resource: 'cube',
  product: 'cube',            // product 는 resource 의 alias.
  concept: 'sphere',
  task: 'diamond',
  procedure: 'diamond',       // procedure/service/problem 은 task family.
  service: 'diamond',
  problem: 'diamond',
  knowledge: 'octahedron',
  event: 'roundedSquare',
  artifact: 'roundedSquare',
  metric: 'cone',
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
  octahedron: '◇',
  cone: '▲',
  pin: '📍',
  dot: '•',
};
