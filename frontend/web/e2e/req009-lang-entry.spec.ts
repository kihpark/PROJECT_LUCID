/**
 * ★ REQ-009 (2026-06-30) — 언어 설정 entry point e2e.
 *
 * PO 의뢰서:
 *   • 한/영 진입점이 화면에 없음 → ★ 노출
 *   • i18n 베타 = 영어 진입 X (★ 지금은 entry point 만)
 *
 * Acceptance:
 *   1. AppShell header 에 언어 entry 보임 (★ "한국어" + globe icon)
 *   2. 클릭 → 한국어 (현재) / English (BETA) 드롭다운 노출
 *   3. English 클릭 → 진입 X, "베타 준비 중" 안내 노출
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

test.describe('REQ-009 — 언어 설정 entry point', () => {
  test('★ AppShell header 에 entry 노출 (★ 모든 페이지)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const trigger = page.locator('[data-testid="app-shell-lang-trigger"]');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-label', '언어 설정');
    await expect(
      page.locator('[data-testid="app-shell-lang-current"]'),
    ).toHaveText('한국어');

    await screenshot(page, 'req009-lang-entry', '01-entry-visible');
  });

  test('★ 클릭 → 드롭다운 (한국어 현재 / English BETA) 노출', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    await page.locator('[data-testid="app-shell-lang-trigger"]').click();
    const menu = page.locator('[data-testid="app-shell-lang-menu"]');
    await expect(menu).toBeVisible();

    await expect(
      page.locator('[data-testid="app-shell-lang-option-ko"]'),
    ).toContainText('한국어');
    await expect(
      page.locator('[data-testid="app-shell-lang-option-ko"]'),
    ).toContainText('현재');
    await expect(
      page.locator('[data-testid="app-shell-lang-option-en"]'),
    ).toContainText('English');
    await expect(
      page.locator('[data-testid="app-shell-lang-option-en"]'),
    ).toContainText('BETA');

    await screenshot(page, 'req009-lang-entry', '02-dropdown-open');
  });

  test('★ English 클릭 → 진입 X, "베타 준비 중" 안내', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    await page.locator('[data-testid="app-shell-lang-trigger"]').click();
    await page.locator('[data-testid="app-shell-lang-option-en"]').click();

    // ★ URL / locale 변경 0 (★ 진입 X 검증).
    expect(page.url()).toContain('/home');
    await expect(
      page.locator('[data-testid="app-shell-lang-current"]'),
    ).toHaveText('한국어');

    // 베타 안내 노출.
    const notice = page.locator('[data-testid="app-shell-lang-beta-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('베타 준비 중');

    await screenshot(page, 'req009-lang-entry', '03-english-beta-notice');
  });
});
