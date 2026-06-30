/**
 * ★ REQ-010 (2026-06-30) — 버전 표기 e2e.
 *
 * PO 의뢰서:
 *   • 화면 하단 "Lucid v0.x.x"
 *   • ★ 실제 0.MINOR dogfood 라운드 연동 (★ version.ts 자동 표시)
 *
 * Acceptance:
 *   1. AppShell footer 에 "Lucid v0.x.x" 노출 (★ 모든 페이지)
 *   2. version.ts 의 LUCID_VERSION 자동 표시 (★ hardcode 0)
 *   3. /home 외 라우트 (★ /recall, /stellar 등) 에서도 보임
 *   4. screenshot 증거
 *
 * Backend 의존성 0 — /api/* mock.
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
        totals: { facts: 5, entities: 3, sources: 1, this_week_validated: 5 },
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });
}

test.describe('REQ-010 — 버전 표기 (★ 화면 하단 / ★ 모든 페이지)', () => {
  test('★ /home 페이지 footer 에 "Lucid v0.x.x" 노출', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const footer = page.locator('[data-testid="app-shell-version-footer"]');
    await expect(footer).toBeVisible();
    // ★ SemVer 0.MINOR.PATCH 패턴.
    await expect(footer).toHaveText(/^Lucid v0\.\d+\.\d+$/);

    await screenshot(page, 'req010-version-footer', '01-home-footer');
  });

  test('★ /recall 페이지에도 동일 footer 노출 (★ 모든 페이지)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const footer = page.locator('[data-testid="app-shell-version-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveText(/^Lucid v0\.\d+\.\d+$/);

    await screenshot(page, 'req010-version-footer', '02-recall-footer');
  });

  test('★ /stellar 페이지에도 동일 footer 노출', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/stellar');
    await page.waitForLoadState('networkidle');

    const footer = page.locator('[data-testid="app-shell-version-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveText(/^Lucid v0\.\d+\.\d+$/);

    await screenshot(page, 'req010-version-footer', '03-stellar-footer');
  });
});
