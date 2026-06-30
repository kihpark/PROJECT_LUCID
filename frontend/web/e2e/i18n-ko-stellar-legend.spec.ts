/**
 * ★ feat/i18n-ko-display-names-separation (PO 2026-06-30) — i18n e2e #2.
 *
 * Acceptance #2 (★ PO verbatim):
 *   STELLAR 범례 = 사람·조직·그룹·자원·개념·행위·사건·장소·발언·기타
 *   (영문 코드 0)
 *
 * 검증:
 *   1. 각 LEGEND row 의 label = 한국어 단일 토큰.
 *   2. LEGEND 전체 텍스트에 영문 코드 (WHO/WHAT/WHERE/EVENT/CLAIM/RESOURCE/
 *      KNOWLEDGE/TASK) 0.
 *   3. LEGEND 타이틀 = "범례" (옛 "LEGEND · 범례" 폐기).
 *   4. data-bucket attribute = 코드네임 유지 (회귀 0).
 *
 * Screenshot 의무: 1 장 (LEGEND 한국어 범례).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('★ i18n stellar legend: 범례 한국어 (영문 코드 0)', async ({
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

  // 1. 타이틀 = "범례" (옛 "LEGEND · 범례" 폐기).
  const title = page.getByTestId('stellar-legend-title');
  await expect(title).toHaveText('범례');

  // 2. 각 row 의 한국어 라벨 verbatim (★ PO 의뢰서 #3).
  const expectedLabels: Record<string, string> = {
    person: '사람',
    organization: '조직',
    group: '그룹',
    'what-resource': '자원·제품',
    'what-knowledge': '개념·지식',
    'what-task': '행위·역할',
    event: '사건',
    place: '장소',
    claim: '발언',
    unknown: '기타',
  };
  for (const [key, label] of Object.entries(expectedLabels)) {
    const item = page.getByTestId(`stellar-legend-item-${key}`);
    await expect(item).toBeVisible();
    await expect(item).toContainText(label);
  }

  // 3. ★ 영문 코드 (WHO/WHAT/WHERE/EVENT/CLAIM/RESOURCE/KNOWLEDGE/TASK)
  //    LEGEND 텍스트에 노출 0.
  const legendText = (await legend.textContent()) ?? '';
  expect(legendText).not.toMatch(/WHO|WHAT|WHERE|EVENT|CLAIM|RESOURCE|KNOWLEDGE|TASK/);
  expect(legendText).not.toMatch(/unknown/);
  expect(legendText).not.toMatch(/LEGEND/);

  // 4. 내부 코드네임 (data-bucket) 유지 검증 — 회귀 0.
  await expect(page.getByTestId('stellar-legend-item-person')).toHaveAttribute('data-bucket', 'WHO');
  await expect(page.getByTestId('stellar-legend-item-what-resource')).toHaveAttribute('data-bucket', 'WHAT');
  await expect(page.getByTestId('stellar-legend-item-claim')).toHaveAttribute('data-bucket', 'CLAIM');
  await expect(page.getByTestId('stellar-legend-item-unknown')).toHaveAttribute('data-bucket', 'unknown');

  await captureEvidence(page, 'i18n-ko-stellar-legend', '01-legend-korean-labels');
});
