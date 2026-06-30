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
  person: '사람',
  organization: '조직',
  group: '그룹',
  resource: '자원',
  product: '제품',
  concept: '개념',
  knowledge: '지식',
  procedure: '행위',
  service: '서비스',
  problem: '문제',
  metric: '지표',
  event: '사건',
  artifact: '산출물',
  place: '장소',
  location: '위치',
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
