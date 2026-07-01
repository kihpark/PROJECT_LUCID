/**
 * feat/i18n-ko-display-names-separation (★ PO 2026-06-30) —
 * 코드네임 (내부 식별자) ↔ 표시명 (사용자 노출) 분리 맵.
 *
 * 원칙:
 *   • 내부 코드·라우트·DB 필드·의뢰 문서 = 코드네임 유지
 *     (HEARTH / HARVEST / DECIDE / RECALL / STELLAR / LEDGER 등).
 *   • 사용자 화면 = 한국어 표시명. ★ 영문 코드 노출 0.
 *   • 표시명을 한 곳에 모아 관리 → 베타 i18n 때 이 파일에 영어만 추가하면
 *     동일 helper 가 lang 인자로 분기. 호출부 (컴포넌트) 는 그대로.
 *
 * ★ 사용자 노출 = 반드시 이 helper / 상수 거쳐서 표시 (★ "여기 한글
 *   저기 영문" 불일치 0 가드).
 */

/** 코드네임 (HEARTH / RECALL / STELLAR …) ↔ 한국어 섹션명.
 *  PO 2026-06-30 의뢰서 표 verbatim. */
export const SECTION_LABELS_KO: Record<string, string> = {
  HEARTH: '홈',
  HARVEST: '수집',
  DECIDE: '검증',
  RECALL: '검색',
  STELLAR: '지식그래프',
  LEDGER: '기록',
};

/** STELLAR LEGEND 상위 bucket (WHO / WHAT / WHERE / EVENT / CLAIM / unknown)
 *  → 한국어 표시. ★ 사용자 화면에서 영문 코드 0. */
export const LEGEND_BUCKET_LABELS_KO: Record<string, string> = {
  WHO: '인물',
  WHAT: '대상',
  WHERE: '장소',
  EVENT: '사건',
  CLAIM: '발언',
  unknown: '기타',
};

/** STELLAR entity_type 토큰 (backend taxonomy) → 한국어. ★ 사용자 노출 시
 *  type identifier (`person`, `organization`) 가 아닌 이 매핑을 사용. */
export const ENTITY_TYPE_LABELS_KO: Record<string, string> = {
  // ★ v3 closed set 10 class — PO 2026-06-30 의뢰서 verbatim.
  person: '사람',
  organization: '조직',
  group: '그룹',
  knowledge: '지식',
  resource: '자원',
  task: '행위',
  concept: '개념',
  event: '사건',
  metric: '지표',
  location: '장소',
  // ── legacy / 보조 매핑 (★ pre-v3 데이터 호환) ─────────────────
  product: '제품',
  procedure: '행위',
  service: '서비스',
  problem: '문제',
  artifact: '산출물',
  place: '장소',
  region: '지역',
  venue: '장소',
};

/** STELLAR fact_type / kind → 한국어 (entity card / hover card 카드 header). */
export const FACT_KIND_LABELS_KO: Record<string, string> = {
  entity: '엔티티',
  claim: '발언',
  action: '행동',
  measurement: '수치',
};

/** 코드네임 → 한국어. 알 수 없으면 입력값 그대로 반환 (호출부 fallback). */
export function sectionLabelKo(code: string): string {
  if (!code) return code;
  return SECTION_LABELS_KO[code.toUpperCase()] ?? code;
}

/** entity_type 토큰 → 한국어. null / 빈 문자열 / unknown → "기타". */
export function entityTypeLabelKo(t: string | null | undefined): string {
  if (!t) return '기타';
  return ENTITY_TYPE_LABELS_KO[t.toLowerCase()] ?? '기타';
}

/** LEGEND bucket (WHO / WHAT / …) → 한국어. */
export function legendBucketLabelKo(bucket: string | null | undefined): string {
  if (!bucket) return '기타';
  return LEGEND_BUCKET_LABELS_KO[bucket] ?? '기타';
}

/** fact_type / kind → 한국어 (entity card / hover header). */
export function factKindLabelKo(kind: string | null | undefined): string {
  if (!kind) return '엔티티';
  return FACT_KIND_LABELS_KO[kind.toLowerCase()] ?? '엔티티';
}

// ---------------------------------------------------------------------------
// ★ REQ-011-v2 dogfood-3 fix (PO 2026-07-01) — canonical_name resolve helpers.
//
// 원칙 (REQ-004 STAGE 3+4 verbatim, PO 재확인 2026-07-01):
//   • UUID / obj-N 은 사용자 화면에 절대 노출하지 않는다.
//   • canonical_name (label) 이 있으면 그대로 표시.
//   • 없으면 "미해결 entity" placeholder (★ UUID 아님).
//   • 출처 UID 도 동일 원칙 — URL(http/https) 는 노출 OK, 그 외는 "미해결 출처".
//
// LedgerView 가 자체 구현하던 resolveLabel / OBJECT_REF_PATTERN 을 여기로 승격.
// 새 컴포넌트가 회귀 없이 재사용하도록 공통화한다.
// ---------------------------------------------------------------------------

/** UUID4 (하이픈 포함) + 옛 obj-N id — 사용자 노출 금지 형식.
 *  ★ RecallEvidenceCard / EntityEditModal / 후속 카드 모두 이 패턴을 안전지대. */
export const OBJECT_REF_PATTERN =
  /^(?:obj-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** entity 미해결 placeholder — subject / object 이 canonical 을 못 끌어올 때. */
export const UNRESOLVED_ENTITY_LABEL = '미해결 entity';

/** source 미해결 placeholder — source_uid 가 UUID 형식이라 사람이 못 읽을 때. */
export const UNRESOLVED_SOURCE_LABEL = '미해결 출처';

/** 값이 UUID / obj-N 모양이면 true (canonical_name 조회 실패 사례). */
export function isUuidLike(value: string | null | undefined): boolean {
  if (!value) return false;
  return OBJECT_REF_PATTERN.test(value);
}

/** ★ 표시층 canonical_name resolver.
 *  label 이 있고 UUID 형식이 아니면 label. 그 외 → "미해결 entity".
 *  ★ UUID 를 그대로 반환하는 경로 없음 (LedgerView 옛 구현과의 차이 —
 *  거긴 value 를 그대로 반환하는 경로가 남아 있었으나, dogfood-3 (PO 2026-
 *  07-01) 재확인으로 "표시층 UUID 노출 0" 을 더 엄격 적용). */
export function resolveEntityLabel(
  label: string | null | undefined,
): string {
  const trimmed = label?.trim();
  if (!trimmed) return UNRESOLVED_ENTITY_LABEL;
  if (isUuidLike(trimmed)) return UNRESOLVED_ENTITY_LABEL;
  return trimmed;
}

/** 출처 라벨 resolver.
 *  http(s):// 로 시작하면 호스트+path 요약을 표시.
 *  그 외 (UUID / bare id) 는 "미해결 출처" placeholder.
 *  ★ v3 후속 = source_labels endpoint 로 canonical title 회수. */
export function resolveSourceLabel(uid: string | null | undefined): string {
  const trimmed = uid?.trim();
  if (!trimmed) return UNRESOLVED_SOURCE_LABEL;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^https?:\/\//i, '').slice(0, 50);
  }
  // ★ v3 = source 테이블 조회. 지금은 UUID / bare id 는 사용자에게 감춘다.
  return UNRESOLVED_SOURCE_LABEL;
}
