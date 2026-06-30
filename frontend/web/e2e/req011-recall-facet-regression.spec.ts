/**
 * ★ M-Dogfood-C (PO 2026-07-01) — recall-facet (좌패널 그래프 렌즈) 회귀 가드.
 *
 * 배경 (PO verbatim):
 *   "삭제된 recall-facet 회귀 가드 (분류·카운트) 새 spec 복구.
 *    REQ-011 v1 의 좌패널 그래프 렌즈 위에 — 박원갑 = 사람 회귀 검증".
 *
 * REQ-011 의 신규 디자인에서 facet 패널 ('대상' chips) 은 entity 명·카운트
 * 만 표시했다. 분류 (사람/조직/장소) 정보가 사라지면 사용자가 "박원갑" 클릭
 * 했을 때 그래프에서 사람 노드로 grouping 될지 즉시 알 수 없다. 옛 facet
 * 의 분류·카운트 회귀 가드를 새 디자인 위에 복구.
 *
 * 검증 (★ 원칙 단위):
 *   1. 모든 entity chip 은 data-entity-name / data-entity-type /
 *      data-entity-type-ko / data-entity-count 4 속성을 가진다.
 *   2. 박원갑 = entity_type 'person' = 한국어 라벨 '사람' (★ 의뢰서 fixture).
 *   3. SpaceX = entity_type 'organization' = '조직'.
 *   4. 분포 sanity: 사람 ≥ 1, 조직 ≥ 1.
 *   5. count attribute 가 NaN / 음수 / 비어 있지 않다.
 *   6. entity_type 한국어 배지가 chip 안에 노출 (★ 사용자 시각 회귀 가드).
 *
 * Backend 의존성 0 — page.route() /api/* mock.
 */
import { test, expect, PO_KS } from './fixtures/auth';
import type { Page } from '@playwright/test';
import { screenshot } from './helpers/req004Flow';

const SEED_USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

async function installApiMocks(page: Page): Promise<void> {
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const token = jwt.sign(
    { sub: SEED_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
  await page.context().addCookies([
    {
      name: 'lucid_space_id',
      value: PO_KS,
      domain: 'localhost',
      path: '/',
    },
  ]);
  await page.addInitScript(
    ({ spaceId, jwtToken }: { spaceId: string; jwtToken: string }) => {
      try {
        window.localStorage.setItem('lucid_space_id', spaceId);
        window.localStorage.setItem('lucid_jwt', jwtToken);
        document.cookie = `lucid_space_id=${spaceId}; path=/; SameSite=Lax`;
      } catch {
        /* fail-soft */
      }
    },
    { spaceId: PO_KS, jwtToken: token },
  );

  // ★ Playwright route priority: LAST registered wins. catchall 먼저 등록,
  //   specific routes 를 뒤에 등록해 specific 가 catchall 보다 우선되도록.
  await page.route(/\/api\//, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: '{}',
    });
  });

  await page.route(/\/api\/auth\/me$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        user_id: SEED_USER_ID,
        email: 'kihpark85@gmail.com',
        display_name: '박기흥',
        default_space_id: PO_KS,
        is_new_user: false,
        is_admin: false,
      }),
    });
  });

  await page.route(/\/api\/home\/brief(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        totals: { facts: 42, entities: 7, sources: 5, this_week_validated: 4 },
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });
}

async function gotoRecall(page: Page): Promise<void> {
  await installApiMocks(page);
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
}

test.describe('M-Dogfood-C — recall-facet 분류·카운트 회귀 가드', () => {
  test('★ 모든 chip 이 4 속성 (name/type/type-ko/count) 보유', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    const facet = page.getByTestId('recall-facet-entities');
    await expect(facet).toBeVisible();

    const chips = page.getByTestId('recall-facet-entity-chip');
    const total = await chips.count();
    expect(total).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < total; i += 1) {
      const chip = chips.nth(i);
      const name = await chip.getAttribute('data-entity-name');
      const type = await chip.getAttribute('data-entity-type');
      const typeKo = await chip.getAttribute('data-entity-type-ko');
      const countRaw = await chip.getAttribute('data-entity-count');
      expect(name).not.toBeNull();
      expect((name ?? '').length).toBeGreaterThan(0);
      expect(type).not.toBeNull();
      expect((type ?? '').length).toBeGreaterThan(0);
      expect(typeKo).not.toBeNull();
      expect((typeKo ?? '').length).toBeGreaterThan(0);
      expect(countRaw).not.toBeNull();
      const n = Number(countRaw);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }

    await screenshot(
      page,
      'req011-recall-facet-regression',
      '01-chip-attributes',
    );
  });

  test('★ 박원갑 = 사람 (★ PO verbatim fixture)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    // ★ name attribute 로 정확히 박원갑 chip 을 잡는다 (다국어 fixture 변경에도
    //   견고하도록 textContent 가 아닌 data-attribute 로 매칭).
    const parkChip = page.locator(
      '[data-testid="recall-facet-entity-chip"][data-entity-name="박원갑"]',
    );
    await expect(parkChip).toBeVisible();
    await expect(parkChip).toHaveAttribute('data-entity-type', 'person');
    await expect(parkChip).toHaveAttribute('data-entity-type-ko', '사람');

    // 한국어 배지가 사용자 화면에도 노출.
    const badge = parkChip.getByTestId('recall-facet-entity-type');
    await expect(badge).toHaveText('사람');

    await screenshot(
      page,
      'req011-recall-facet-regression',
      '02-park-is-person',
    );
  });

  test('★ SpaceX = 조직', async ({ authenticatedPage: page }) => {
    await gotoRecall(page);

    const sx = page.locator(
      '[data-testid="recall-facet-entity-chip"][data-entity-name="SpaceX"]',
    );
    await expect(sx).toBeVisible();
    await expect(sx).toHaveAttribute('data-entity-type', 'organization');
    await expect(sx).toHaveAttribute('data-entity-type-ko', '조직');
  });

  test('★ 분포 sanity — 사람 ≥ 1, 조직 ≥ 1', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    const personChips = page.locator(
      '[data-testid="recall-facet-entity-chip"][data-entity-type="person"]',
    );
    const orgChips = page.locator(
      '[data-testid="recall-facet-entity-chip"][data-entity-type="organization"]',
    );
    expect(await personChips.count()).toBeGreaterThanOrEqual(1);
    expect(await orgChips.count()).toBeGreaterThanOrEqual(1);
  });

  test('★ 한국어 배지가 모든 chip 에 노출 (시각 회귀)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    const chips = page.getByTestId('recall-facet-entity-chip');
    const total = await chips.count();
    for (let i = 0; i < total; i += 1) {
      const badge = chips.nth(i).getByTestId('recall-facet-entity-type');
      await expect(badge).toBeVisible();
      const text = (await badge.textContent())?.trim() ?? '';
      // ★ 한국어 라벨 — '사람/조직/그룹/지식/자원/행위/개념/사건/지표/장소/제품…/기타'.
      //   모든 라벨이 ENTITY_TYPE_LABELS_KO map 의 값 = 한국어 (★ 영문 코드 0).
      expect(text.length).toBeGreaterThan(0);
      expect(/[A-Za-z]/.test(text)).toBe(false);
    }

    await screenshot(
      page,
      'req011-recall-facet-regression',
      '03-korean-badges-everywhere',
    );
  });
});
