/**
 * ★ L2 (STELLAR legend/shape/hover, PO 2026-06-29) — WHO 묶음 안에서 person /
 * organization / group 의 시각 구분.
 *
 * 3D canvas 의 mesh geometry 는 Playwright 가 직접 raycast 할 수 없다 → 대신
 * (a) stellarShapes / stellarColors 의 unit-level 분리는 vitest 가 보장하고
 * (b) e2e 는 LEGEND 안의 swatch 들이 서로 다른 색·형태 문자를 보여주는지
 *     사용자 surface 에서 검증한다. 사용자가 LEGEND 를 보면 person / org /
 *     group 이 어떤 형태/색인지 즉시 알 수 있다는 게 L2 의 핵심.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('L2: WHO subtypes (person/org/group) are visually distinct in the legend', async ({
  authenticatedPage: page,
}) => {
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

  const person = page.getByTestId('stellar-legend-swatch-person');
  const org = page.getByTestId('stellar-legend-swatch-organization');
  const group = page.getByTestId('stellar-legend-swatch-group');

  await expect(person).toBeVisible();
  await expect(org).toBeVisible();
  await expect(group).toBeVisible();

  // ★ L2 — shape characters must differ (sphere / cube / diamond).
  const personChar = (await person.textContent())?.trim() ?? '';
  const orgChar = (await org.textContent())?.trim() ?? '';
  const groupChar = (await group.textContent())?.trim() ?? '';
  const shapes = new Set([personChar, orgChar, groupChar]);
  expect(shapes.size).toBe(3);

  // ★ L2 — colors must differ too (teal / cyan / lime).
  const personColor = await person.evaluate((el) => getComputedStyle(el).color);
  const orgColor = await org.evaluate((el) => getComputedStyle(el).color);
  const groupColor = await group.evaluate((el) => getComputedStyle(el).color);
  const colors = new Set([personColor, orgColor, groupColor]);
  expect(colors.size).toBe(3);

  await captureEvidence(page, 'l2-shape-distinct', '01-legend-shapes-and-colors-distinct');
});
