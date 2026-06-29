/**
 * ★ U2 (STELLAR UX 자가 점검, 2026-06-29) — `unknown` bucket 토글 surface.
 *
 * 원칙: 모든 entity bucket 은 사용자가 토글로 끌 수 있어야 한다.
 * 위반: null/unmapped entity_type → 'unknown' bucket → 좌패널 토글 X →
 *      사용자가 끌 수 없음.
 * Fix: 좌패널 ENTITY 섹션에 '기타 · unknown' 토글 추가.
 *      entityBuckets state 에 unknown 키 추가, filter 가 unknown 노드도
 *      해당 토글 값에 따라 surface / hide.
 *
 * 검증:
 *   - SEED 5번 fact: subject 'Delta' (entity_type=null) → unknown bucket.
 *   - 좌패널 unknown 토글이 보이고 default ON 이어서 'Delta' 가 search 결과로
 *     나옴 (baseline).
 *   - unknown 토글 OFF → 'Delta' 검색 결과 0 (★ 끌 수 있다는 증명).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('U2: WHERE 필터 — 기타 unknown 토글 추가로 사용자가 끌 수 있다', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // 1. 좌패널 unknown 토글이 노출 — surface 존재 단정.
  const unknownToggle = page.getByTestId('stellar-filter-entity-unknown');
  await expect(unknownToggle).toBeVisible();
  await expect(unknownToggle).toBeChecked();

  // 2. Baseline — 'Delta' (entity_type=null) 가 검색에서 surface.
  const search = page.getByTestId('stellar-search-input');
  await search.fill('Delta');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('stellar-search-result').first()).toBeVisible();
  await captureEvidence(page, 'u2-where-unknown-toggle', '01-unknown-on');
  await search.fill('');

  // 3. unknown 토글 OFF → 'Delta' 가 사라짐.
  await unknownToggle.click();
  await expect(unknownToggle).not.toBeChecked();
  await page.waitForTimeout(300);
  await search.fill('Delta');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('stellar-search-result')).toHaveCount(0);

  await captureEvidence(page, 'u2-where-unknown-toggle', '02-unknown-off');
});
