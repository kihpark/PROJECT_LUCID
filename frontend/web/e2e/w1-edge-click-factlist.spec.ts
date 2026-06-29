/**
 * ★ W1 (STELLAR 6-class fix, 2026-06-29) — edge click → fact list.
 *
 * Uses the hidden e2e hook `stellar-e2e-fire-edge-click` (display:none in
 * production) to dispatch setEdgeClick → StellarEdgeFactsList mounts.
 * The hook fires the FIRST link in filteredData; production code path
 * (setEdgeClick) is what gets exercised.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('W1: edge click opens StellarEdgeFactsList', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const hook = page.getByTestId('stellar-e2e-fire-edge-click');
  // The hook button is display:none. force-click still requires the
  // element to be visible; dispatchEvent bypasses that check while
  // still firing the React onClick handler that production wires.
  await hook.dispatchEvent('click');

  const list = page.getByTestId('stellar-edge-facts-list');
  await expect(list).toBeVisible();

  await captureEvidence(page, 'w1-edge-click-factlist', '01-edge-list-open');
});
