/**
 * ★ 2026-07-01 (PO verbatim: "자원/개념/행위/지식/사건/지표 전부 구분되게.
 *   일부만 태그 X. 형태·명도·라벨 전부 구분되게") — LEGEND WHAT 6 소분류
 *   전부 분리 가드.
 *
 * 옛 결정 폐기: "같은 amber 색 공유 (색 분리 X)" 옵션 → PO 정정 이후 6 sub-row
 *   전부 색 (명도) · 형태 · 한국어 라벨 3 채널 완전 분리.
 *
 * 검증:
 *   1. WHAT 6 sub-row (what-resource / what-concept / what-task /
 *      what-knowledge / what-event / what-metric) 모두 노출.
 *   2. 6 row 의 shape attribute 가 서로 다르다
 *      (cube / sphere / diamond / octahedron / roundedSquare / cone).
 *   3. 6 row 의 color attribute (amber family 6 명도) 도 서로 다르다.
 *   4. 6 row 모두에 subBucketLabelKo 배지 (자원/개념/행위/지식/사건/지표) 노출.
 *   5. 한국어 라벨 (자원 / 개념 / 행위 / 지식 / 사건 / 지표) 이 화면에 보인다.
 *   6. WHO / WHERE / CLAIM / unknown 행에는 sub-bucket 배지 미노출 (★ over-
 *      rendering 가드).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

const WHAT_ROWS = [
  { key: 'what-resource', shape: 'cube', badge: '자원', label: '자원' },
  { key: 'what-concept', shape: 'sphere', badge: '개념', label: '개념' },
  { key: 'what-task', shape: 'diamond', badge: '행위', label: '행위' },
  { key: 'what-knowledge', shape: 'octahedron', badge: '지식', label: '지식' },
  { key: 'what-event', shape: 'roundedSquare', badge: '사건', label: '사건' },
  { key: 'what-metric', shape: 'cone', badge: '지표', label: '지표' },
] as const;

test('★ WHAT 6 소분류 = 형태·명도·라벨·배지 3 채널 전부 분리', async ({
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

  // ── 1. 6 row 모두 노출, data-bucket = WHAT ─────────────────────────
  const shapes: string[] = [];
  const colors: string[] = [];
  for (const row of WHAT_ROWS) {
    const item = page.getByTestId(`stellar-legend-item-${row.key}`);
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-bucket', 'WHAT');
    const s = await item.getAttribute('data-shape');
    const c = await item.getAttribute('data-color');
    expect(s).toBe(row.shape);
    expect(c).toBeTruthy();
    shapes.push(s ?? '');
    colors.push(c ?? '');
  }

  // ── 2. 6 형태 전부 다름 (일부만 태그 X 가드) ────────────────────────
  expect(new Set(shapes).size).toBe(6);

  // ── 3. 6 명도 전부 다름 (★ 옛 "같은 amber 색 공유" 결정 폐기) ──────
  expect(new Set(colors).size).toBe(6);

  // ── 4. 6 row 모두 sub-bucket 배지 노출 (한국어) ─────────────────────
  for (const row of WHAT_ROWS) {
    const badge = page.getByTestId(`stellar-legend-subbucket-${row.key}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(row.badge);
  }

  // ── 5. 한국어 라벨 화면 노출 ────────────────────────────────────────
  for (const row of WHAT_ROWS) {
    const item = page.getByTestId(`stellar-legend-item-${row.key}`);
    await expect(item).toContainText(row.label);
  }

  await captureEvidence(
    page,
    'legend-what-subcategory-shape',
    '01-what-6-subcategories-all-distinct',
  );
});

test('★ WHO/WHERE/CLAIM/unknown 행에는 sub-bucket 배지 미노출 (over-rendering 가드)', async ({
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
