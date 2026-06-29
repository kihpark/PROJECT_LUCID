/**
 * ★ W3 (STELLAR 6-class fix, 2026-06-29) — WHERE 필터 → person 잔존 닫힘.
 *
 * Unchecks WHO + WHAT, leaves WHERE only → person entity (Alpha Corp)
 * should no longer surface. Verified via the search bar — typing 'Alpha'
 * should produce zero search results because Alpha Corp (organization →
 * who bucket) is filtered out.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('W3: WHERE-only filter hides WHO entities (Alpha Corp gone)', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Baseline — Alpha is reachable via search.
  const search = page.getByTestId('stellar-search-input');
  await search.fill('Alpha');
  await expect(page.getByTestId('stellar-search-result').first()).toBeVisible();
  await captureEvidence(page, 'w3-where-filter-person-zero', '01-before-filter');
  await search.fill('');

  // Uncheck WHO and WHAT (keep WHERE on).
  await page.getByTestId('stellar-filter-entity-who').click();
  await page.getByTestId('stellar-filter-entity-what').click();
  await page.waitForTimeout(300);

  // Alpha (organization → WHO) should now be absent from search.
  await search.fill('Alpha');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('stellar-search-result')).toHaveCount(0);

  await captureEvidence(page, 'w3-where-filter-person-zero', '02-after-filter');
});
