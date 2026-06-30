/**
 * ★ fix/stellar-v1-v2-v4-legend-class (PO 2026-06-29) — STELLAR LEGEND ↔ 노드
 * single source of truth.
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
 *
 * Fix 원칙 (★ same-source):
 *   • LEGEND 와 nodeThreeObject 둘 다 이 파일의 LEGEND_SPECS 와
 *     specForEntityType() 만 본다. 한쪽에서 매핑을 바꾸면 양쪽이 자동 동기화
 *     되어 V2 의 "안내 vs 실제 불일치" 가 구조적으로 불가능해진다.
 *   • specForEntityType(null | unknown) = LEGEND_SPECS 의 'unknown' row 와
 *     동일한 spec — 색·형태가 사람/조직 어떤 것과도 다른 작은 점 (dot, 회색).
 *   • WHAT 묶음은 LEGEND 한 줄을 3 sub-row (RESOURCE / KNOWLEDGE / TASK) 로
 *     확장 — 같은 amber 색을 공유 (★ PO 결정: 색 분리 X) 하되 한국어 안내가
 *     달라서 사용자가 의미를 알 수 있다.
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

export type LegendBucket = 'WHO' | 'WHAT' | 'EVENT' | 'WHERE' | 'CLAIM' | 'unknown';

export interface LegendSpec {
  /** Stable key for React + data-testid. */
  key: string;
  /** Top-level legend bucket label (used by tests / future grouping). */
  bucket: LegendBucket;
  /** Sub-bucket label for V1+ (WHAT 의 RESOURCE / KNOWLEDGE / TASK). */
  subBucket?: string;
  /** ★ M-Dogfood-C (PO 2026-07-01) — WHAT 묶음 시각 보강.
   *  WHAT 의 cube/sphere/diamond 형태는 WHO 묶음 (organization/person/group)
   *  과 형태가 겹친다 (색만 다름). 사용자가 "이 cube 가 조직인가 자원인가" 를
   *  즉각 구분할 수 있도록 LEGEND 의 WHAT 행에 한국어 sub-bucket 한 글자
   *  배지를 별도로 노출한다. WHO / WHERE / EVENT / CLAIM / unknown 은 undefined
   *  (배지 미노출). */
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
 *  유지 — 회귀 0. */
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
  // WHAT 묶음 — sub-bucket 분리 (RESOURCE / KNOWLEDGE / TASK). 색은 같은
  // amber 공유, 형태와 한국어 라벨이 의미 전달.
  {
    key: 'what-resource',
    bucket: 'WHAT',
    subBucket: 'RESOURCE',
    subBucketLabelKo: '자원',
    label: '자원·제품',
    entity_types: ['resource', 'product'],
    shape: 'cube',
    color: ENTITY_COLORS.product,
  },
  {
    key: 'what-knowledge',
    bucket: 'WHAT',
    subBucket: 'KNOWLEDGE',
    subBucketLabelKo: '개념',
    label: '개념·지식',
    entity_types: ['concept', 'knowledge'],
    shape: 'sphere',
    color: ENTITY_COLORS.concept,
  },
  {
    key: 'what-task',
    bucket: 'WHAT',
    subBucket: 'TASK',
    subBucketLabelKo: '행위',
    label: '행위·역할',
    // procedure / service / problem / metric — backend taxonomy 의 "task"
    // family. ★ entity_types 에 없는 새 토큰이 들어와도 unknown 으로 fallback
    // 하므로 안전. metric 도 여기에 끼워 두면 metric 노드가 LEGEND 한 자리에
    // 표시된다.
    entity_types: ['procedure', 'service', 'problem', 'metric', 'task'],
    shape: 'diamond',
    color: ENTITY_COLORS.product,
  },
  // EVENT — 둥근사각 / violet.
  {
    key: 'event',
    bucket: 'EVENT',
    label: '사건',
    entity_types: ['event', 'artifact'],
    shape: 'roundedSquare',
    color: ENTITY_COLORS.event,
  },
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
