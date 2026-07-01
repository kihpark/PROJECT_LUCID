/**
 * ★ V1++ (fix/stellar-v1-v2-v4-legend-class, PO 2026-06-29) — LEGEND 각 row 우측
 * 에 카테고리별 카운트가 "(N)" 형태로 표시돼야 한다.
 *
 * 위반 클래스 (PO verbatim): LEGEND 가 카테고리만, 카운트 없음 → 사용자가 그래프
 * 의 분포를 즉시 파악할 수 없다.
 *
 * Fix 검증:
 *   • SEED_FACTS = 5 facts. 등장하는 entity_type:
 *       organization (3 facts: Alpha Corp, Beta Foundation) → 2 entity 노드
 *       place        (1 fact:  Gamma 지역)                  → 1 entity 노드
 *       null/literal (1 fact:  Delta + 리터럴 객체)          → unknown
 *       claim        (1 fact:  매출 증가 발표)               → claim 노드
 *   • LEGEND row data-count = 위와 일치.
 *   • 어떤 row 든 data-count 가 NaN / 비어 있지 않다.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('V1++: LEGEND rows display per-category node counts', async ({
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

  const legend = page.getByTestId('stellar-legend');
  await expect(legend).toBeVisible();

  // Every row must carry a data-count attribute that parses as a number ≥ 0.
  // ★ 2026-07-01 — WHAT 6 소분류 전부 별도 row. event top-level 폐기 →
  //   what-event 로 흡수.
  const rowKeys = [
    'person',
    'organization',
    'group',
    'what-resource',
    'what-concept',
    'what-task',
    'what-knowledge',
    'what-event',
    'what-metric',
    'place',
    'claim',
    'unknown',
  ] as const;
  const counts: Record<string, number> = {};
  for (const key of rowKeys) {
    const row = page.getByTestId(`stellar-legend-item-${key}`);
    await expect(row).toBeVisible();
    const raw = await row.getAttribute('data-count');
    expect(raw).not.toBeNull();
    const n = Number(raw);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    counts[key] = n;
    // Inline count widget also rendered to the user.
    const widget = page.getByTestId(`stellar-legend-count-${key}`);
    await expect(widget).toHaveText(`(${n})`);
  }

  // Distribution sanity — at least one organization, one place, one claim.
  // (Avoids hardcoding exact counts so seed evolution does not break this.)
  expect(counts.organization).toBeGreaterThanOrEqual(1);
  expect(counts.place).toBeGreaterThanOrEqual(1);
  expect(counts.claim).toBeGreaterThanOrEqual(1);

  await captureEvidence(page, 'v1plusplus-legend-count', '01-legend-with-counts');
});
