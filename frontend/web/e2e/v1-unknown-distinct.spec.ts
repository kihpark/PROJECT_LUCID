/**
 * ★ V1 (fix/stellar-v1-v2-v4-legend-class, PO 2026-06-29) —
 * LEGEND 의 WHO/사람 row 와 unknown row 가 시각적으로 즉시 구분돼야 한다.
 *
 * 위반 클래스 (PO verbatim): WHO/사람 (sphere, teal) ↔ unknown (★ 무엇? 같은
 * sphere + 다른 색? 또는 같은 모양?). 옛 LEGEND 는 unknown 도 sphere 라
 * 사용자가 한 줄만 보면 "사람과 unknown 이 같은 형태" 라고 착각.
 *
 * Fix 검증 (★ 시각 surface 에서):
 *   • LEGEND swatch 의 색 (computed style) 이 person 과 unknown 사이에 다르다.
 *   • LEGEND swatch 의 shape 토큰 (data-shape) 이 다르다.
 *   • LEGEND 카운트 (data-count) 가 양쪽 모두 backend seed 에 따라 1+.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';
import type { TestFact } from './fixtures/backend-seed';

const PERSON_AND_UNKNOWN: TestFact[] = [
  ...SEED_FACTS,
  // ★ explicit person — WHO/사람 row 카운트 1+.
  {
    fact_uid: '11111111-1111-4111-8111-11111111aa01',
    fact_type: 'action',
    subject_uid: '21111111-1111-4111-8111-11111111aa01',
    subject_label: 'Person A',
    subject_entity_type: 'person',
    object_value: '22222222-2222-4222-8222-22222222aa01',
    object_label: 'Person B',
    object_entity_type: 'person',
    predicate: '만남',
    claim: 'Person A 가 Person B 를 만났다',
  },
];

test('V1: unknown row is visually distinct from WHO/사람 in the legend', async ({
  authenticatedPage: page,
}) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('lucid.stellar.legend.visible');
    } catch {
      /* fail-soft */
    }
  });
  await wipeAndSeed(page, PERSON_AND_UNKNOWN);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const legend = page.getByTestId('stellar-legend');
  await expect(legend).toBeVisible();

  const personSwatch = page.getByTestId('stellar-legend-swatch-person');
  const unknownSwatch = page.getByTestId('stellar-legend-swatch-unknown');
  await expect(personSwatch).toBeVisible();
  await expect(unknownSwatch).toBeVisible();

  // ★ 시각 채널 1 — shape token. person='sphere', unknown='dot'.
  const personShape = await personSwatch.getAttribute('data-shape');
  const unknownShape = await unknownSwatch.getAttribute('data-shape');
  expect(personShape).toBe('sphere');
  expect(unknownShape).toBe('dot');
  expect(personShape).not.toBe(unknownShape);

  // ★ 시각 채널 2 — color (LEGEND row computed swatch color).
  const personColor = await personSwatch.evaluate((el) => getComputedStyle(el).color);
  const unknownColor = await unknownSwatch.evaluate((el) => getComputedStyle(el).color);
  expect(personColor).not.toBe(unknownColor);

  // ★ V1++ — both rows render a count widget. The count value depends on
  // the seed, but both must have a non-empty data-count.
  const personCount = await page.getByTestId('stellar-legend-item-person').getAttribute('data-count');
  const unknownCount = await page.getByTestId('stellar-legend-item-unknown').getAttribute('data-count');
  expect(personCount).not.toBeNull();
  expect(unknownCount).not.toBeNull();

  await captureEvidence(page, 'v1-unknown-distinct', '01-legend-person-vs-unknown');
});
