/**
 * v3 §6 그래프 구성 규칙의 원칙 단위 assert 골격.
 * ★ 시그니처 + TODO 만. 실제 assert 본문 = REQ-006-v2 (STAGE 0 진단 후).
 * ★ 특정 케이스 하드코딩 금지 — 원칙 단위.
 *
 * ★ REQ-006-v1 (2026-06-30) — PO 의뢰서 STEP 1.2
 * ★ test/e2e 파일 only — 구현 코드 0
 */
import type { Page } from '@playwright/test';

/**
 * 원칙: 모든 ACTION = entity 간 엣지.
 * 위반 클래스: action fact 가 노드로 그려지거나 literal object 잔존.
 *
 * TODO(v2 — STAGE 1·3 후):
 *   - DOM 또는 API 응답 검사로 위반 0 확인
 *   - data-action-edge attr 또는 graph state 확인
 *   - "fact node" pattern 0 검증
 */
export async function assertAllActionsAreEdges(page: Page): Promise<void> {
  // TODO(v2): STAGE 0 진단 결과로 노출 구조 확정 후 본문
  void page;
  throw new Error('TODO(v2) — STAGE 0 진단 후 채움');
}

/**
 * 원칙: 모든 CLAIM = 명제 노드 + 양태 (assertion/judgment/opinion).
 * 위반 클래스: claim 이 엣지로 처리되거나 mentioned entity 끼리 직접 엣지.
 *
 * TODO(v2 — STAGE 1·2 후):
 *   - claim 노드 = data-kind="claim" 또는 fact.fact_type=='claim'
 *   - modality 배지 검증 (assertion/judgment/opinion)
 *   - mentioned entity 직접 엣지 0
 */
export async function assertAllClaimsAreNodes(page: Page): Promise<void> {
  void page;
  throw new Error('TODO(v2) — STAGE 0 진단 후 채움');
}

/**
 * 원칙: MEASUREMENT = entity 속성 (귀속형) 또는 metric entity 노드 (독립형).
 * 위반 클래스: measurement 가 별도 fact 노드로 뜨거나, 귀속형이 노드로 분리.
 *
 * TODO(v2 — STAGE 2 후):
 *   - 귀속형 measurement → entity card 의 measurements 섹션
 *   - 독립형 metric → 별도 노드 (data-entity-type="metric")
 *   - 그 외 노드화 0
 */
export async function assertMeasurementsAreAttributes(page: Page): Promise<void> {
  void page;
  throw new Error('TODO(v2) — STAGE 0 진단 후 채움');
}

/**
 * 원칙: 모든 entity 참조 = entity_id (★ 문자열 저장 경로 제거).
 * 위반 클래스: subject/object/speaker/mentioned 에 literal string 잔존.
 *
 * TODO(v2 — STAGE 1·2 후):
 *   - API 응답에 object_value: literal string 0
 *   - 또는 discriminated union 형식 검증
 *   - speaker_uid / roles 의 entity_id 형식 검증
 */
export async function assertEntityRefsAreIds(page: Page): Promise<void> {
  void page;
  throw new Error('TODO(v2) — STAGE 0 진단 후 채움');
}

/**
 * 원칙: 같은 entity type = 같은 색 / 다른 type = 다른 색 (또는 형태).
 * 위반 클래스: 같은 type 다른 색 / degree 무관 균일 크기 / unknown 잘못된 색.
 *
 * TODO(v2 — STAGE 4 후):
 *   - 10종 타입별 색·형태 일관 검증
 *   - LEGEND ↔ 실제 1:1 일치 (★ V2 fix 와 연동)
 *   - same-source 가드
 */
export async function assertTypeColorConsistency(page: Page): Promise<void> {
  void page;
  throw new Error('TODO(v2) — STAGE 0 진단 후 채움');
}
