/**
 * ★ W5 (STELLAR 6-class fix, 2026-06-29) — claim self-count "이 발언 1건".
 *
 * Searches for a claim fragment → clicks the result → claim card mounts →
 * asserts the new `stellar-entity-card-claim-self-count` element renders
 * "이 발언 1건" semantics (replaces any prior fact-count surface).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('W5: claim card shows "이 발언 1건" self-count', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const search = page.getByTestId('stellar-search-input');
  await search.fill('매출');
  await page.waitForTimeout(500);

  const firstResult = page.getByTestId('stellar-search-result').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click({ force: true });

  const claimCard = page.getByTestId('stellar-entity-card-claim');
  await expect(claimCard).toBeVisible();

  const selfCount = page.getByTestId('stellar-entity-card-claim-self-count');
  await expect(selfCount).toBeVisible();
  await expect(selfCount).toHaveText(/이 발언 1건/);

  await captureEvidence(page, 'w5-claim-self-count', '01-self-count');
});
