/**
 * REQ-004 검증용 공통 flow 헬퍼.
 * 모든 STAGE 검증 시나리오가 이 helper 를 재사용.
 *
 * ★ REQ-006-v1 (2026-06-30) — PO 의뢰서 STEP 1.1
 * ★ test/e2e 파일 only — 구현 코드 0
 */
import type { Page } from '@playwright/test';
import { wipeAndSeed } from '../fixtures/backend-seed';
import { captureEvidence } from './screenshot';
import type { TestFact } from '../fixtures/backend-seed';

/**
 * 시나리오 텍스트 또는 fact array → 시드.
 * STAGE 0 후 실제 캡처 path 와 정합 (v2 갱신).
 */
export async function seedCapture(
  page: Page,
  scenario: string | TestFact[],
): Promise<void> {
  if (typeof scenario === 'string') {
    // v1: 단순 placeholder — STAGE 0 진단 후 실제 capture endpoint 정합
    // TODO(v2): /api/spaces/{ks}/capture POST 시뮬레이션 또는 LLM emulation
    throw new Error('seedCapture(string) — v2 에서 구현. 지금은 TestFact[] 만');
  }
  await wipeAndSeed(page, scenario);
}

/**
 * STELLAR 페이지 진입 + REAL 모드 + 그래프 로드 대기.
 */
export async function gotoStellar(page: Page): Promise<void> {
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  // REAL 모드 토글
  const realBtn = page.getByRole('button', { name: /REAL/i });
  if (await realBtn.isVisible().catch(() => false)) {
    await realBtn.click();
  }
  // 그래프 render 대기
  await page.waitForTimeout(1500);
}

export async function gotoRecall(page: Page): Promise<void> {
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
}

export async function gotoHearth(page: Page): Promise<void> {
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
}

/**
 * 명명된 screenshot 저장 (★ 증거 첨부 표준화).
 * 모든 REQ-004 / REQ-006 시나리오가 이 helper 만 사용.
 */
export async function screenshot(
  page: Page,
  scenarioName: string,
  label: string,
): Promise<string> {
  return captureEvidence(page, scenarioName, label);
}
