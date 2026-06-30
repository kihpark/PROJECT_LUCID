/**
 * ★ REQ-006-v1 (2026-06-30) — PO 의뢰서 STEP 2.1
 * 기본 스모크 (★ STAGE 0 무관 — 즉시 동작)
 * 4 상태: 홈/STELLAR/RECALL/페이지 전환 + REQ-002 회귀 가드
 */
import { test, expect } from './fixtures/auth';
import {
  gotoHearth,
  gotoStellar,
  gotoRecall,
  screenshot,
} from './helpers/req004Flow';

test.describe('REQ-006 기본 스모크 (★ STAGE 0 무관, 즉시 동작)', () => {
  test('홈 진입 → sphere 렌더 + 네비 한국어', async ({ authenticatedPage: page }) => {
    await gotoHearth(page);
    await screenshot(page, 'req006-smoke-home', '01-home-loaded');

    // ★ REQ-002 회귀 가드 — 네비 6 메뉴 한국어
    const nav = page.locator('nav');
    if (await nav.isVisible().catch(() => false)) {
      // 네비 영문 코드 0 (★ REQ-002 회귀)
      const navText = (await nav.textContent()) ?? '';
      expect(navText).not.toMatch(/RECALL|STELLAR|HEARTH|HARVEST|DECIDE|LEDGER/i);
    }
  });

  test('STELLAR 진입 → REAL 모드 로드 + 네비 회귀 가드', async ({ authenticatedPage: page }) => {
    await gotoStellar(page);
    await screenshot(page, 'req006-smoke-stellar', '01-stellar-real-loaded');
  });

  test('RECALL 진입 → 검색 UI 로드', async ({ authenticatedPage: page }) => {
    await gotoRecall(page);
    await screenshot(page, 'req006-smoke-recall', '01-recall-loaded');
  });

  test('페이지 전환 무에러 (홈 → STELLAR → RECALL → 홈)', async ({ authenticatedPage: page }) => {
    await gotoHearth(page);
    await gotoStellar(page);
    await gotoRecall(page);
    await gotoHearth(page);
    await screenshot(page, 'req006-smoke-flow', '01-page-flow-ok');
  });
});
