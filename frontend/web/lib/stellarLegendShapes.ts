/**
 * ★ fix/stellar-v1-v2-v4-legend-class (PO 2026-06-29) — STELLAR LEGEND ↔ 노드
 * single source of truth.
 * ★ 2026-07-01 (PO verbatim: "자원/개념/행위/지식/사건/지표 전부 구분되게.
 *   일부만 태그 X. 형태·명도·라벨 전부 구분되게") — WHAT 6 소분류 전부 별도
 *   row (형태·명도·라벨 3 채널 완전 분리). 옛 "same amber 공유" 결정 폐기.
 *
 * 위반 클래스 (PO verbatim):
 *   V1.  WHO/사람 vs unknown 시각 동일 → 같은 sphere + 다른 색? 무엇? → 사용자가
 *        unknown 인지 사람 인지 즉시 구분 불가능.
 *   V1+. WHAT 안의 RESOURCE / KNOWLEDGE / TASK 가 LEGEND 한 줄 — 사용자가 amber
 *        sphere 가 자원/제품/지식/행위/역할 중 어디인지 알 수 없다.
 *   V1++. LEGEND 가 카테고리만 있고 카운트가 없다 — 분포 시각 즉시 파악 불가.
 *   V2.  LEGEND "WHERE = 빨간 구 + 핀셋" 안내인데 실제는 "회색 원형뿔". LEGEND
 *        이 안내하는 모양/색과 ForceGraph3D 의 nodeThreeObject 가 그리는 모양/
 *        색이 따로 살아 있어서 사용자가 안내를 받아도 화면에서 못 찾는다.
 *   ★ WHAT-6. (2026-07-01 PO) "자원/개념/행위/지식/사건/지표 = 6 소분류 인데
 *        일부만 태그되어 있고, 색이 동일해 사용자가 amber cube 가 자원인지
 *        행위인지 모른다" — 6 sub-row 로 완전 분리. amber family 6 명도 +
 *        6 형태 (cube/sphere/diamond/octahedron/roundedSquare/cone).
 *
 * Fix 원칙 (★ same-source):
 *   • LEGEND 와 nodeThreeObject 둘 다 이 파일의 LEGEND_SPECS 와
 *     specForEntityType() 만 본다. 한쪽에서 매핑을 바꾸면 양쪽이 자동 동기화
 *     되어 V2 의 "안내 vs 실제 불일치" 가 구조적으로 불가능해진다.
 *   • specForEntityType(null | unknown) = LEGEND_SPECS 의 'unknown' row 와
 *     동일한 spec — 색·형태가 사람/조직 어떤 것과도 다른 작은 점 (dot, 회색).
 *   • WHAT 묶음은 LEGEND 6 sub-row (자원/개념/행위/지식/사건/지표) 로 완전
 *     확장. amber family 6 명도 (F5C36B→A94D00) + 6 형태. 옛 EVENT top-level
 *     bucket 폐기 (사건 = WHAT sub).
 *   • LEGEND row 우측에 "({count})" — props.nodes 로 들어온 현재 노드들 중
 *     spec.entity_types 에 해당하는 개수.
 */
import type { StellarShape } from './stellarShapes';
import { ENTITY_COLORS, CLAIM_NODE_COLOR } from './stellarColors';

/** ★ V1 — unknown 의 fix 시각: 작은 점 (다른 모든 entity 와 다른 형태) + neutral
 *  grey. ENTITY_SHAPES / ENTITY_COLORS 와 분리해 두는 이유: unknown 은 단순한
 *  "이 entity_type 매핑이 없다" 가 아니라 의미적으로 "분류 실패" — LEGEND 에서
 *  도 같은 라벨로 안내해야 한다. */
export const UNKNOWN_SHAPE: StellarShape = 'dot';
export const UNKNOWN_COLOR = '#9CA3AF';

/** ★ 2026-07-01 (PO): EVENT 별개 top-level bucket 폐기 — 사건 은 WHAT 6 소분류
 *  중 하나. amber family 6 명도 안에서 표시 (색 별개 bucket 유지 X). type
 *  literal 에서는 'EVENT' 유지 (호출부·테스트 회귀 0) 하지만 LEGEND_SPECS 는
 *  더 이상 EVENT bucket row 를 emit 하지 않는다. */
export type LegendBucket = 'WHO' | 'WHAT' | 'EVENT' | 'WHERE' | 'CLAIM' | 'unknown';

export interface LegendSpec {
  /** Stable key for React + data-testid. */
  key: string;
  /** Top-level legend bucket label (used by tests / future grouping). */
  bucket: LegendBucket;
  /** Sub-bucket label for V1+ (WHAT 의 RESOURCE / KNOWLEDGE / TASK). */
  subBucket?: string;
  /** ★ M-Dogfood-C (PO 2026-07-01) — WHAT 묶음 시각 보강.
   *  ★ 2026-07-01 확장: PO "자원/개념/행위/지식/사건/지표 전부 구분되게. 일부
   *  만 태그 X" — WHAT 6 소분류 모두 subBucketLabelKo 배지 노출 (자원/개념/
   *  행위/지식/사건/지표). WHO / WHERE / CLAIM / unknown 은 undefined
   *  (배지 미노출).
   *  ★ 2026-07-01 (PO 재수정 verbatim: "박스 태그 제거 (어수선). 형태를 주
   *  구분자로") — data 필드 유지 하지만 StellarLegend 에서 render X. 회귀 시
   *  다시 노출하고 싶을 때를 위한 data 는 lib 에 그대로 둔다 (a11y screen
   *  reader 등 향후 재활용 여지). */
  subBucketLabelKo?: string;
  /** Korean label shown in the legend row. */
  label: string;
  /** Entity-type tokens this spec matches — used for both renderer dispatch
   *  AND for the V1++ count (nodes.filter(n => spec.entity_types.includes(n.entity_type))). */
  entity_types: string[];
  /** Shape token (consumed by nodeThreeObject + SHAPE_LABEL in legend). */
  shape: StellarShape;
  /** Display color (consumed by nodeThreeObject + legend swatch). */
  color: string;
}

/** ★ Single source of truth. Order = visible legend order.
 *
 *  feat/i18n-ko-display-names-separation (★ PO 2026-06-30): LEGEND row 의
 *  `label` 은 ★ 한국어만 (영문 코드 WHO/WHAT/RESOURCE 등 노출 0). 내부
 *  식별자 (`bucket`, `subBucket`, `key`, `entity_types`) 는 코드네임
 *  유지 — 회귀 0.
 *
 *  ★ 2026-07-01 (PO verbatim: "자원/개념/행위/지식/사건/지표 전부 구분되게.
 *  일부만 태그 X. 형태·명도·라벨 전부 구분되게"):
 *    - WHAT 6 소분류 모두 별도 row (한국어 라벨 · 6 명도 amber · 6 형태).
 *    - 옛 EVENT top-level bucket 폐기 → WHAT/사건 (roundedSquare, amber-700).
 *    - subBucketLabelKo 배지는 6 WHAT row 전부에 노출 (일부만 태그 X). */
export const LEGEND_SPECS: ReadonlyArray<LegendSpec> = [
  // WHO 묶음 — 형태 분리 (sphere / cube / diamond), 색 미세 분리.
  // 라벨은 한국어 단일 토큰 (사람 / 조직 / 그룹).
  {
    key: 'person',
    bucket: 'WHO',
    subBucket: 'person',
    label: '사람',
    entity_types: ['person'],
    shape: 'sphere',
    color: ENTITY_COLORS.person,
  },
  {
    key: 'organization',
    bucket: 'WHO',
    subBucket: 'organization',
    label: '조직',
    entity_types: ['organization'],
    shape: 'cube',
    color: ENTITY_COLORS.organization,
  },
  {
    key: 'group',
    bucket: 'WHO',
    subBucket: 'group',
    label: '그룹',
    entity_types: ['group'],
    shape: 'diamond',
    color: ENTITY_COLORS.group,
  },
  // ── WHAT 6 소분류 ─────────────────────────────────────────────────────
  // ★ 2026-07-01 PO — 6 sub-row 전부. 각 row 는 형태·명도·라벨 3 채널로
  //   완전히 구분된다. subBucketLabelKo 배지도 6 row 모두에 노출.
  {
    key: 'what-resource',
    bucket: 'WHAT',
    subBucket: 'RESOURCE',
    subBucketLabelKo: '자원',
    label: '자원',
    // resource / product — "자원" family. product 는 legacy alias 로 유지.
    entity_types: ['resource', 'product'],
    shape: 'cube',
    color: ENTITY_COLORS.resource,
  },
  {
    key: 'what-concept',
    bucket: 'WHAT',
    subBucket: 'CONCEPT',
    subBucketLabelKo: '개념',
    label: '개념',
    entity_types: ['concept'],
    shape: 'sphere',
    color: ENTITY_COLORS.concept,
  },
  {
    key: 'what-task',
    bucket: 'WHAT',
    subBucket: 'TASK',
    subBucketLabelKo: '행위',
    label: '행위',
    // task / procedure / service / problem — "task" family.
    entity_types: ['task', 'procedure', 'service', 'problem'],
    shape: 'diamond',
    color: ENTITY_COLORS.task,
  },
  {
    key: 'what-knowledge',
    bucket: 'WHAT',
    subBucket: 'KNOWLEDGE',
    subBucketLabelKo: '지식',
    label: '지식',
    entity_types: ['knowledge'],
    shape: 'octahedron',
    color: ENTITY_COLORS.knowledge,
  },
  {
    key: 'what-event',
    bucket: 'WHAT',
    subBucket: 'EVENT',
    subBucketLabelKo: '사건',
    label: '사건',
    // ★ 옛 EVENT top-level bucket 폐기, WHAT/사건 sub-row 로 흡수.
    //   entity_types 는 그대로 (event / artifact) → 회귀 0.
    entity_types: ['event', 'artifact'],
    shape: 'roundedSquare',
    color: ENTITY_COLORS.event,
  },
  {
    key: 'what-metric',
    bucket: 'WHAT',
    subBucket: 'METRIC',
    subBucketLabelKo: '지표',
    label: '지표',
    entity_types: ['metric'],
    shape: 'cone',
    color: ENTITY_COLORS.metric,
  },
  // ── /WHAT ────────────────────────────────────────────────────────────
  // ★ 2026-07-01 회귀 브릿지 — 옛 'event' key row 를 원하는 호출부가 있을 수
  //   있어 test-id `stellar-legend-item-event` 를 유지해야 할 필요가 있다면
  //   테스트에서 what-event 로 참조하도록 수정. LEGEND 상 event top-level
  //   bucket row 는 폐기.
  // WHERE — ★ V2 fix: LEGEND 의 형태/색과 renderer 가 그리는 형태/색이 1:1.
  // shape='pin' → nodeThreeObject 에서 ConeGeometry, color=#7A8CA3 (slate).
  {
    key: 'place',
    bucket: 'WHERE',
    label: '장소',
    entity_types: ['place', 'location', 'region', 'venue'],
    shape: 'pin',
    color: ENTITY_COLORS.place,
  },
  // CLAIM — entity 가 아니라 "발언" 노드. entity_types 는 비워 두고 매핑은
  // node.kind === 'claim' / node.fact_type === 'claim' 으로 nodeThreeObject 가
  // 직접 분기 — specForEntityType 의 fallback 으로 들어오지 않도록 한다.
  {
    key: 'claim',
    bucket: 'CLAIM',
    label: '발언',
    entity_types: [],
    shape: 'dot',
    color: CLAIM_NODE_COLOR,
  },
  // unknown — ★ V1 fix: 색·형태 모두 다른 entity 와 분리. 작은 점 + neutral
  // grey 라 사용자가 "이건 unknown 이다" 라고 즉시 인식할 수 있다.
  {
    key: 'unknown',
    bucket: 'unknown',
    label: '기타',
    entity_types: [],
    shape: UNKNOWN_SHAPE,
    color: UNKNOWN_COLOR,
  },
];

/** Last spec (unknown) — exported separately so callers can reach the
 *  "unresolved" spec without scanning the array. The non-null assertion is
 *  safe: LEGEND_SPECS is a hand-written non-empty const tuple. */
export const UNKNOWN_SPEC: LegendSpec = LEGEND_SPECS[LEGEND_SPECS.length - 1]!;

/** ★ V2 — single dispatch for the renderer. Returns the spec whose
 *  entity_types includes the given (lowercased) token; falls back to
 *  UNKNOWN_SPEC when there is no match OR the input is null/empty.
 *  CLAIM is intentionally NOT matched here (entity_types: []) — callers
 *  that render claim nodes should branch on node.kind / fact_type BEFORE
 *  calling this helper. */
export function specForEntityType(entityType: string | null | undefined): LegendSpec {
  if (!entityType) return UNKNOWN_SPEC;
  const key = entityType.toLowerCase();
  // Skip the CLAIM spec (its entity_types are empty so it won't match) and
  // the unknown spec (matches everything as fallback). Iterate explicitly so
  // a future entity_types collision between two specs has deterministic
  // order = LEGEND_SPECS order.
  for (const spec of LEGEND_SPECS) {
    if (spec.bucket === 'unknown') continue;
    if (spec.entity_types.includes(key)) return spec;
  }
  return UNKNOWN_SPEC;
}

/** ★ V2 — explicit accessor for the CLAIM spec (renderer branches on
 *  node.kind / fact_type). Keeps the colour/shape pair in lock-step with
 *  the LEGEND row that the user sees. */
export function claimSpec(): LegendSpec {
  const found = LEGEND_SPECS.find((s) => s.bucket === 'CLAIM');
  // ★ Defensive: LEGEND_SPECS always has a CLAIM row by construction; the
  // fallback keeps the type checker happy without changing behaviour.
  return found ?? UNKNOWN_SPEC;
}
