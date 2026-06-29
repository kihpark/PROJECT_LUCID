/**
 * ★ U4 (STELLAR UX 자가 점검, 2026-06-29) — EntityCard 딥링크 작동 검증.
 *
 * 원칙: LEDGER / RECALL 딥링크 = 클릭 시 실제 페이지 진입.
 * 위반: 옛 e2e 는 button visible 만 단정. 실제 href 가 spec 형식 인지,
 *      클릭 시 navigation 이 정확한 param 으로 이뤄지는지 0 검증.
 * Fix:
 *   - href 가 spec 형식 (/ledger?entity_uid=X, /recall?focus=X).
 *   - 클릭 후 URL 가 동일한 entity_uid / focus 로 도달.
 *
 * 검증:
 *   - 'Alpha' search → 첫 결과 클릭 → EntityCard mount.
 *   - LEDGER 딥링크 href = /ledger?entity_uid=<uid> 형식.
 *   - RECALL 딥링크 href = /recall?focus=<uid> 형식.
 *   - LEDGER 클릭 → URL 에 entity_uid 가 포함된 ledger 페이지로 이동.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('U4: EntityCard 딥링크 — href = spec 형식 + 클릭 navigation', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Alpha entity 검색 → 첫 결과 클릭.
  const search = page.getByTestId('stellar-search-input');
  await search.fill('Alpha');
  const firstResult = page.getByTestId('stellar-search-result').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click({ force: true });

  // EntityCard 출현.
  const card = page.getByTestId('stellar-entity-card');
  await expect(card).toBeVisible();

  // LEDGER 딥링크 href 단정 — spec 형식 `/ledger?entity_uid=<uid>`.
  const ledgerLink = page.getByTestId('stellar-entity-card-ledger-link');
  await expect(ledgerLink).toBeVisible();
  const ledgerHref = await ledgerLink.getAttribute('href');
  expect(ledgerHref).not.toBeNull();
  expect(ledgerHref!).toMatch(/^\/ledger\?entity_uid=[^&]+$/);

  // RECALL 딥링크 href 단정 — spec 형식 `/recall?focus=<uid>`.
  const recallLink = page.getByTestId('stellar-entity-card-recall-link');
  await expect(recallLink).toBeVisible();
  const recallHref = await recallLink.getAttribute('href');
  expect(recallHref).not.toBeNull();
  expect(recallHref!).toMatch(/^\/recall\?focus=[^&]+$/);

  await captureEvidence(page, 'u4-entitycard-deeplinks', '01-href-verified');

  // 동일 entity_uid 가 두 링크에 들어가 있는지 검증 (★ 일관성).
  const entityUidFromLedger = new URL(
    ledgerHref!,
    'http://localhost',
  ).searchParams.get('entity_uid');
  const focusFromRecall = new URL(
    recallHref!,
    'http://localhost',
  ).searchParams.get('focus');
  expect(entityUidFromLedger).not.toBeNull();
  expect(entityUidFromLedger).toBe(focusFromRecall);

  // LEDGER 딥링크 click → navigation 검증.
  await Promise.all([
    page.waitForURL(/\/ledger\?entity_uid=/, { timeout: 10_000 }),
    ledgerLink.click(),
  ]);
  expect(page.url()).toMatch(/\/ledger\?entity_uid=/);

  await captureEvidence(page, 'u4-entitycard-deeplinks', '02-ledger-navigated');
});
