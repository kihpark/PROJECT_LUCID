/**
 * ★ M-Dogfood-C (PO 2026-07-01) — LEGEND WHAT 소분류 형태·라벨 분리 가드.
 *
 * 배경 (PO verbatim):
 *   "범례 WHAT 소분류 (자원/개념/행위/지식) = 색 같아도 형태·라벨로 구분".
 *
 * V1+ fix (LEGEND_SPECS 단일 source) 이후 WHAT 묶음의 cube/sphere/diamond
 * 형태가 WHO 묶음 (organization/person/group) 과 형태가 겹친다 (색만 다름).
 * 사용자가 "이 cube 가 조직인가 자원인가" 를 즉각 구분할 수 있도록 LEGEND
 * 의 WHAT 행에 한국어 sub-bucket 한 글자 배지 (자원·개념·행위) 가 별도로
 * 노출돼야 한다 — 본 spec 이 회귀 가드.
 *
 * 검증:
 *   1. WHAT 묶음 3 행 (what-resource / what-knowledge / what-task) 의 shape
 *      attribute 가 서로 다르다 (cube / sphere / diamond).
 *   2. 각 행에 subBucketLabelKo 배지 (자원/개념/행위) 가 노출.
 *   3. 한국어 라벨 (자원·제품 / 개념·지식 / 행위·역할) 이 화면에 보인다.
 *   4. 같은 amber 색을 공유 (색 분리 X — PO 결정).
 *   5. WHO / WHERE / EVENT / CLAIM / unknown 행에는 sub-bucket 배지 미노출
 *      (★ over-rendering 가드).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('★ WHAT 소분류 = 형태·라벨·배지 3 채널 분리', async ({
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

  const resource = page.getByTestId('stellar-legend-item-what-resource');
  const knowledge = page.getByTestId('stellar-legend-item-what-knowledge');
  const task = page.getByTestId('stellar-legend-item-what-task');

  for (const row of [resource, knowledge, task]) {
    await expect(row).toBeVisible();
    // 한국어 라벨 (영문 코드 노출 0).
    await expect(row).toHaveAttribute('data-bucket', 'WHAT');
  }

  // 형태 분리 — 셋이 모두 달라야.
  const shapeR = await resource.getAttribute('data-shape');
  const shapeK = await knowledge.getAttribute('data-shape');
  const shapeT = await task.getAttribute('data-shape');
  expect(shapeR).toBe('cube');
  expect(shapeK).toBe('sphere');
  expect(shapeT).toBe('diamond');
  // 명시적 분리 검증 (★ 형태 같으면 즉시 fail).
  expect(new Set([shapeR, shapeK, shapeT]).size).toBe(3);

  // 같은 amber 색 공유 (★ PO 결정 — 색 분리 X, 형태·라벨로만).
  const colorR = await resource.getAttribute('data-color');
  const colorK = await knowledge.getAttribute('data-color');
  const colorT = await task.getAttribute('data-color');
  expect(colorR).toBe(colorK);
  expect(colorK).toBe(colorT);

  // 한국어 sub-bucket 배지.
  const badgeR = page.getByTestId('stellar-legend-subbucket-what-resource');
  const badgeK = page.getByTestId('stellar-legend-subbucket-what-knowledge');
  const badgeT = page.getByTestId('stellar-legend-subbucket-what-task');
  await expect(badgeR).toBeVisible();
  await expect(badgeK).toBeVisible();
  await expect(badgeT).toBeVisible();
  await expect(badgeR).toHaveText('자원');
  await expect(badgeK).toHaveText('개념');
  await expect(badgeT).toHaveText('행위');

  // 한국어 long-label (자원·제품 등) 이 화면에 보인다.
  await expect(resource).toContainText('자원·제품');
  await expect(knowledge).toContainText('개념·지식');
  await expect(task).toContainText('행위·역할');

  await captureEvidence(
    page,
    'legend-what-subcategory-shape',
    '01-what-subcategories-distinct',
  );
});

test('★ WHO/WHERE/EVENT/CLAIM/unknown 행에는 sub-bucket 배지 미노출', async ({
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

  // sub-bucket 배지가 노출되면 안 되는 행.
  const nonWhatKeys = [
    'person',
    'organization',
    'group',
    'event',
    'place',
    'claim',
    'unknown',
  ];
  for (const key of nonWhatKeys) {
    const badge = page.getByTestId(`stellar-legend-subbucket-${key}`);
    await expect(badge).toHaveCount(0);
  }
});

test('★ WHO 와 WHAT 형태 충돌 시 색·배지로 구분 (이중 채널 가드)', async ({
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

  // WHO/organization = cube (사이안), WHAT/resource = cube (앰버).
  const org = page.getByTestId('stellar-legend-item-organization');
  const resource = page.getByTestId('stellar-legend-item-what-resource');
  expect(await org.getAttribute('data-shape')).toBe('cube');
  expect(await resource.getAttribute('data-shape')).toBe('cube');
  // 형태 충돌 — 그러나 색이 달라야 (★ 채널 #1).
  const colorOrg = await org.getAttribute('data-color');
  const colorRes = await resource.getAttribute('data-color');
  expect(colorOrg).not.toBe(colorRes);
  // WHAT 쪽에만 sub-bucket 배지 (★ 채널 #2).
  await expect(
    page.getByTestId('stellar-legend-subbucket-organization'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('stellar-legend-subbucket-what-resource'),
  ).toBeVisible();
});
