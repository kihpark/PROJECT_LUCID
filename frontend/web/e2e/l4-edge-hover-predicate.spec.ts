/**
 * ★ L4 (STELLAR legend/shape/hover, PO 2026-06-29) — edge hover = predicate only.
 *
 * 3D canvas onLinkHover raycast 는 Playwright 가 직접 fire 못 함 → e2e 전용
 * hover hook (`stellar-e2e-fire-edge-hover`, display:none) 으로 production
 * handleLinkHover 경로를 발화시킨다. 보이는 surface 는 production 과 동일.
 *
 * 검증:
 *   • tooltip 이 visible
 *   • predicate label 만 표시 (SPO 전체 X / fact list X)
 *   • clear 후 tooltip 사라짐
 *   • click 은 별도 동작 (W1: EdgeFactsList) — hover 와 click 분리
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('L4: edge hover renders predicate-only tooltip', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Move cursor to a known position so the tooltip has stable coords.
  await page.mouse.move(640, 360);

  // Fire the production link-hover path.
  await page.getByTestId('stellar-e2e-fire-edge-hover').dispatchEvent('click');

  const tooltip = page.getByTestId('stellar-edge-hover-tooltip');
  await expect(tooltip).toBeVisible();

  const text = (await tooltip.textContent())?.trim() ?? '';
  expect(text.length).toBeGreaterThan(0);

  // ★ L4 — predicate-only: tooltip must NOT contain the SPO arrow
  // " → " (used by the SPO hover card) or the fact-list testid surface.
  expect(text).not.toContain('→');
  // The tooltip should NOT contain entity names (Alpha Corp / Beta Foundation)
  // — those would indicate SPO leakage. (Defensive: predicate only.)
  expect(text).not.toContain('Alpha Corp');
  expect(text).not.toContain('Beta Foundation');

  // The EdgeFactsList (click surface) must NOT be open from hover.
  await expect(page.getByTestId('stellar-edge-facts-list')).toHaveCount(0);

  await captureEvidence(page, 'l4-edge-hover-predicate', '01-edge-hover-tooltip');

  // ★ Clearing hover removes the tooltip.
  await page.getByTestId('stellar-e2e-clear-edge-hover').dispatchEvent('click');
  await page.waitForTimeout(200);
  await expect(page.getByTestId('stellar-edge-hover-tooltip')).toHaveCount(0);

  // ★ Click is a different action — edge click opens EdgeFactsList (W1).
  await page.getByTestId('stellar-e2e-fire-edge-click').dispatchEvent('click');
  await expect(page.getByTestId('stellar-edge-facts-list')).toBeVisible();

  await captureEvidence(page, 'l4-edge-hover-predicate', '02-edge-click-opens-factslist');
});
