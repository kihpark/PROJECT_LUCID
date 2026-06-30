/**
 * ★ REQ-006-v1 (2026-06-30) — PO 의뢰서 STEP 2.2
 * 회귀 가드 — REQ-002 (한국어) + REQ-003 (자동완성) 보존
 */
import { test, expect } from './fixtures/auth';
import {
  gotoHearth,
  gotoRecall,
  screenshot,
} from './helpers/req004Flow';

test.describe('REQ-006 회귀 가드 (★ REQ-002 + REQ-003 보존)', () => {
  test('REQ-002 회귀: 네비 한국어 (영문 0)', async ({ authenticatedPage: page }) => {
    await gotoHearth(page);
    // ★ 네비/heading 안에 있어야 함 (★ data-testid 는 보존)
    const visibleText = await page.evaluate(() => {
      const els = document.querySelectorAll('nav, h1, h2, header');
      return Array.from(els)
        .map((e) => e.textContent ?? '')
        .join(' ');
    });
    expect(visibleText).not.toMatch(/\b(RECALL|STELLAR|HEARTH|HARVEST|DECIDE|LEDGER)\b/);
    await screenshot(page, 'req006-regression-i18n', '01-nav-korean');
  });

  test('REQ-003 회귀: 자동완성 "." 제거', async ({ authenticatedPage: page }) => {
    await gotoRecall(page);
    await screenshot(page, 'req006-regression-dot', '01-recall-search');
    // ★ 실제 검증 = REQ-003 의 V4 spec 이 처리 — 이건 스모크 가드만
  });
});
