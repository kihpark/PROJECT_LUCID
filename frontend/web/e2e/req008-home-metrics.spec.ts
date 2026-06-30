/**
 * ★ REQ-008 (2026-06-30) — 홈 humility 카피 → 실데이터 4 지표 e2e.
 *
 * v1: "제가 아는 건 당신이 검증한 99개의 사실뿐입니다…" — facts 1개만.
 * v2: "검증된 사실 N · 엔티티 M · 출처 P · 이번 주 +K" — 4 지표 모두.
 *
 * Acceptance:
 *   1. 실데이터 source = /api/home/brief (★ 신설 endpoint 0 — D2 검증)
 *   2. 4 지표 모두 mock 값 반영 (★ 하드코딩 0)
 *   3. screenshot 증거
 *
 * Backend 의존성 0 — page.route() 로 /api/* mock.
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

async function installApiMocks(
  page: Page,
  totals: {
    facts: number;
    entities: number;
    sources: number;
    this_week_validated: number;
  },
): Promise<void> {
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const token = jwt.sign(
    { sub: SEED_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
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
        totals,
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });
}

test.describe('REQ-008 — 홈 humility 카피 실데이터 4 지표', () => {
  test('★ 4 지표 모두 brief.totals 에서 mock 값 그대로 노출', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page, {
      facts: 247,
      entities: 89,
      sources: 34,
      this_week_validated: 12,
    });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const humility = page.locator('[data-testid="home-humility"]');
    await expect(humility).toBeVisible();

    await expect(
      page.locator('[data-testid="home-humility-facts"]'),
    ).toHaveText('247');
    await expect(
      page.locator('[data-testid="home-humility-entities"]'),
    ).toHaveText('89');
    await expect(
      page.locator('[data-testid="home-humility-sources"]'),
    ).toHaveText('34');
    await expect(
      page.locator('[data-testid="home-humility-this-week"]'),
    ).toHaveText('+12');

    // 카피 라벨 (영문 코드 0 — 한국어 라벨만).
    await expect(humility).toContainText('검증된 사실');
    await expect(humility).toContainText('엔티티');
    await expect(humility).toContainText('출처');
    await expect(humility).toContainText('이번 주');

    // ★ v1 카피 회귀 가드 — "당신이 검증한" / "99개의 사실" 사라짐.
    await expect(humility).not.toContainText('당신이 검증한');
    await expect(humility).not.toContainText('99개의 사실');

    await screenshot(page, 'req008-home-metrics', '01-real-metrics-line');
  });

  test('★ 다른 mock 값 → 다른 표시 (하드코딩 0 검증)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page, {
      facts: 5,
      entities: 3,
      sources: 1,
      this_week_validated: 5,
    });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    await expect(
      page.locator('[data-testid="home-humility-facts"]'),
    ).toHaveText('5');
    await expect(
      page.locator('[data-testid="home-humility-entities"]'),
    ).toHaveText('3');
    await expect(
      page.locator('[data-testid="home-humility-sources"]'),
    ).toHaveText('1');
    await expect(
      page.locator('[data-testid="home-humility-this-week"]'),
    ).toHaveText('+5');

    await screenshot(page, 'req008-home-metrics', '02-small-values');
  });
});
