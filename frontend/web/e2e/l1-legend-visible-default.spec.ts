/**
 * ★ L1 (STELLAR legend/shape/hover, PO 2026-06-29) — LEGEND default visible.
 *
 * Asserts that on first /stellar load, StellarLegend mounts in visible
 * state, lists the entity-type swatches (WHO 3종 + WHAT + EVENT + WHERE
 * + CLAIM + unknown), and that the toggle button collapses it on click.
 * Screenshot evidence captured for both the visible and collapsed surface.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('L1: STELLAR LEGEND is visible by default with all vocabulary items', async ({
  authenticatedPage: page,
}) => {
  // Clear any persisted preference so the default-visible policy is what
  // the user would see on a real first visit.
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('lucid.stellar.legend.visible');
    } catch {
      /* fail-soft */
    }
  });
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const legend = page.getByTestId('stellar-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('data-visible', '1');

  // Vocabulary items — WHO 3종 (person / organization / group) must be
  // distinct rows so the user can read the L2 shape distinction off the
  // legend itself.
  await expect(page.getByTestId('stellar-legend-item-person')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-organization')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-group')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-what')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-event')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-place')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-claim')).toBeVisible();
  await expect(page.getByTestId('stellar-legend-item-unknown')).toBeVisible();

  await captureEvidence(page, 'l1-legend-visible-default', '01-legend-default-visible');

  // ★ User can collapse — 화면 점유 가드.
  const toggle = page.getByTestId('stellar-legend-toggle');
  await toggle.click();
  await page.waitForTimeout(300);
  await expect(legend).toHaveAttribute('data-visible', '0');
  await expect(page.getByTestId('stellar-legend-list')).toHaveCount(0);

  await captureEvidence(page, 'l1-legend-visible-default', '02-legend-collapsed');
});
