/**
 * ★ W2 (STELLAR 6-class fix, 2026-06-29) — entity measurement values surface.
 *
 * Searches for "Alpha" → clicks the result → StellarEntityCard mounts →
 * the new measurements section renders entity.measurements rows.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('W2: entity card surfaces measurement metric/value/unit/as_of', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const search = page.getByTestId('stellar-search-input');
  await search.fill('Alpha');

  // Click the first matching result (Alpha Corp entity node).
  const firstResult = page.getByTestId('stellar-search-result').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click({ force: true });

  // Either the entity card or claim card mounts. We want the entity one.
  const card = page.getByTestId('stellar-entity-card');
  await expect(card).toBeVisible();

  const measurements = page.getByTestId('stellar-entity-card-measurements');
  await expect(measurements).toBeVisible();
  await expect(measurements).toContainText('수치');
  const rows = page.getByTestId('stellar-entity-card-measurement-row');
  await expect(rows.first()).toBeVisible();

  await captureEvidence(page, 'w2-entity-measurement', '01-measurement-section');
});
