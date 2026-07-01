/**
 * ★ 2026-07-01 (PO 재수정 verbatim: "박스 태그 제거 (어수선). WHAT 6 소분류
 *   = 색(명도) + 형태(6종) + 라벨. 명도 차이는 눈에 약함 → 형태를 주 구분자로.
 *   색은 보조. amber 계열이어도 형태로 한눈에 갈리게") — LEGEND WHAT 6 소분류
 *   전부 분리 가드. 옛 배지 render 폐기.
 *
 * 옛 결정 폐기:
 *   - "같은 amber 색 공유 (색 분리 X)" (M-Dogfood-C, 2026-06-30)
 *   - "6 소분류 sub-bucket 배지 노출" (2026-07-01 fix/…-what-subdivide-all)
 *
 * 검증:
 *   1. WHAT 6 sub-row (what-resource / what-concept / what-task /
 *      what-knowledge / what-event / what-metric) 모두 노출.
 *   2. 6 row 의 shape attribute 가 서로 다르다
 *      (cube / sphere / diamond / octahedron / roundedSquare / cone).
 *      ★ 형태 = 주 구분자.
 *   3. 6 row 의 color attribute (amber family 6 명도) 도 서로 다르다.
 *      ★ 색 = 보조 구분자.
 *   4. 6 row 모두 sub-bucket 배지 render 0 (★ 어수선 폐기).
 *   5. 한국어 라벨 (자원 / 개념 / 행위 / 지식 / 사건 / 지표) 이 화면에 보인다.
 *   6. WHO / WHERE / CLAIM / unknown 행에도 sub-bucket 배지 미노출.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

const WHAT_ROWS = [
  { key: 'what-resource', shape: 'cube', label: '자원' },
  { key: 'what-concept', shape: 'sphere', label: '개념' },
  { key: 'what-task', shape: 'diamond', label: '행위' },
  { key: 'what-knowledge', shape: 'octahedron', label: '지식' },
  { key: 'what-event', shape: 'roundedSquare', label: '사건' },
  { key: 'what-metric', shape: 'cone', label: '지표' },
] as const;

test('★ WHAT 6 소분류 = 형태(주) + 명도(보조) + 라벨 3 채널 분리, 배지 render 0', async ({
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

  // ── 2. 6 형태 전부 다름 (★ 주 구분자 가드) ─────────────────────────
  expect(new Set(shapes).size).toBe(6);

  // ── 3. 6 명도 전부 다름 (★ 보조 구분자, amber family) ─────────────
  expect(new Set(colors).size).toBe(6);

  // ── 4. 6 row 모두 sub-bucket 배지 render 0 (★ 어수선 폐기 가드) ───
  for (const row of WHAT_ROWS) {
    const badge = page.getByTestId(`stellar-legend-subbucket-${row.key}`);
    await expect(badge).toHaveCount(0);
  }

  // ── 5. 한국어 라벨 화면 노출 ────────────────────────────────────────
  for (const row of WHAT_ROWS) {
    const item = page.getByTestId(`stellar-legend-item-${row.key}`);
    await expect(item).toContainText(row.label);
  }

  await captureEvidence(
    page,
    'legend-what-subcategory-shape',
    '01-what-6-form-first-no-badge',
  );
});

test('★ 전체 legend 어느 행에도 sub-bucket 배지 render 0 (over-rendering 가드)', async ({
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

  // ★ 2026-07-01 PO 재수정: 배지 노출 X = WHAT/WHO/WHERE/CLAIM/unknown
  // 어느 행에서도 배지 render 되지 않는다. testid prefix `stellar-legend-
  // subbucket-` 로 찍은 요소는 페이지에 하나도 없어야 한다.
  const badges = page.locator('[data-testid^="stellar-legend-subbucket-"]');
  await expect(badges).toHaveCount(0);
});

test('★ WHO 와 WHAT 형태 충돌 시 색으로만 구분 (배지 없음, 색이 보조 채널)', async ({
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
  // 형태 충돌 — 그러나 색이 달라야 (★ 유일 잔존 채널: 색 · 라벨).
  const colorOrg = await org.getAttribute('data-color');
  const colorRes = await resource.getAttribute('data-color');
  expect(colorOrg).not.toBe(colorRes);
  // ★ 2026-07-01 — 배지 render 0. 옛 배지 채널 폐기.
  await expect(
    page.getByTestId('stellar-legend-subbucket-organization'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('stellar-legend-subbucket-what-resource'),
  ).toHaveCount(0);
});
