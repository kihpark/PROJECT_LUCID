/**
 * ★ N1 (STELLAR 6-class fix, 2026-06-29) — CLAIM toggle default ON evidence.
 *
 * Asserts that on first /stellar load, the "발언(CLAIM) 보기" toggle's
 * aria-pressed === "true" and label contains '숨김'. This is the visible
 * surface of the N1 violation class closure.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('N1: CLAIM toggle is ON by default', async ({ authenticatedPage: page }) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const toggle = page.getByTestId('stellar-claim-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toContainText('숨김');

  await captureEvidence(page, 'n1-claim-default-on', '01-toggle-on');
});
