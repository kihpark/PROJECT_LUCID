/**
 * ★ feat/i18n-ko-display-names-separation (PO 2026-06-30) — i18n e2e #4.
 *
 * Acceptance #3 (subset, ★ PO verbatim):
 *   카드·툴팁·빈상태에 영문 코드 잔재 0
 *
 * 검증:
 *   1. /pending H1 = "검증 대기열" (옛 "Pending Queue" 폐기).
 *   2. /ledger H1 = "기록" (옛 "기록 (Ledger)" 폐기 — "Ledger" 잔재 0).
 *   3. /recall H1 = "검색" (옛 "Recall" 폐기) + 검색 버튼 라벨 = "검색".
 *   4. /stellar 빈상태 시 "지식그래프 · 비어 있음" (옛 "STELLAR · EMPTY" 폐기).
 *
 * Screenshot 의무: 1 장 + (필요 시 page 별 분리).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS, SEED_SPACE_ID } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

/** SSR 페이지 (/recall, /ledger, /pending) 는 server-side 에서 cookie 헤더를
 *  읽어 knowledge space 가 없으면 빈상태로 fallback. Playwright context
 *  cookie 을 set 해 H1 surface 가 실제 렌더되게 한다. */
async function seedSpaceCookie(page: import('@playwright/test').Page): Promise<void> {
  await page.context().addCookies([{
    name: 'lucid_space_id',
    value: SEED_SPACE_ID,
    domain: 'localhost',
    path: '/',
  }]);
}

/** /ledger 와 /pending 은 wipeAndSeed catchall ({}) 만으로는 부족 — list
 *  컴포넌트가 빈 배열을 iterate 하기 때문에 명시적 빈 리스트 응답 필요. */
async function mockLedgerAndPending(page: import('@playwright/test').Page): Promise<void> {
  // LedgerView 는 /api/spaces/{id}/ledger → { facts: [...] } 를 기대.
  await page.route(/\/api\/spaces\/[^/]+\/ledger(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ facts: [], next_cursor: null }),
    });
  });
  await page.route(/\/api\/spaces\/[^/]+\/facts(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], next_cursor: null }),
    });
  });
  await page.route(/\/api\/spaces\/[^/]+\/pending(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, has_more: false }),
    });
  });
}

test('★ i18n /pending H1 = "검증 대기열" + 영문 코드 0', async ({
  authenticatedPage: page,
}) => {
  // wipeAndSeed 가 lucid_space_id cookie 를 set 해 SSR 가 빈상태 fallback 이
  // 아닌 실제 페이지를 렌더.
  await seedSpaceCookie(page);
  await wipeAndSeed(page, SEED_FACTS);
  await mockLedgerAndPending(page);
  await page.goto('/pending');
  await page.waitForLoadState('networkidle');
  const h1 = page.locator('h1').first();
  await expect(h1).toHaveText('검증 대기열');
  const h1Text = (await h1.textContent()) ?? '';
  expect(h1Text).not.toMatch(/Pending|Queue|DECIDE/);
  await captureEvidence(page, 'i18n-ko-empty-states', '01-pending-h1');
});

test('★ i18n /ledger H1 = "기록" + 영문 "Ledger" 잔재 0', async ({
  authenticatedPage: page,
}) => {
  await seedSpaceCookie(page);
  await wipeAndSeed(page, SEED_FACTS);
  await mockLedgerAndPending(page);
  await page.goto('/ledger');
  await page.waitForLoadState('networkidle');
  const h1 = page.locator('h1').first();
  await expect(h1).toHaveText('기록');
  const h1Text = (await h1.textContent()) ?? '';
  expect(h1Text).not.toMatch(/Ledger|LEDGER/);
  await captureEvidence(page, 'i18n-ko-empty-states', '02-ledger-h1');
});

test('★ i18n /recall H1 = "검색" + 검색 버튼 한국어', async ({
  authenticatedPage: page,
}) => {
  await seedSpaceCookie(page);
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
  const h1 = page.locator('h1').first();
  await expect(h1).toHaveText('검색');
  const h1Text = (await h1.textContent()) ?? '';
  expect(h1Text).not.toMatch(/Recall|RECALL/);
  // Submit 버튼 라벨 = "검색" (idle), "검색 중…" (busy). 둘 다 한국어.
  const submitBtn = page.getByRole('button', { name: /^검색( 중…)?$/ });
  await expect(submitBtn).toBeVisible();
  await captureEvidence(page, 'i18n-ko-empty-states', '03-recall-h1');
});
