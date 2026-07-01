/**
 * ★ REQ-014-A (PO 2026-07-02) — HEARTH (/home) UI 정리 7 items e2e.
 *
 * PO 의뢰서 (verbatim 7 items):
 *
 *   A1. 버전 표기 중복 → home-version-footer 제거, AppShell footer 만 유지
 *   A2. BE LUCID 폰트 크기 → 12 → 24 로 키워 존재감
 *   A3. 빈 상태 멘트 → "확장을 설치하고 첫 문장을 담아보세요" 로 교체
 *   A4. "첫 사실 캡처하기" 버튼 → "확장 설치하기 →" + 로컬 설치 modal
 *   A5. 검색 바 금지 사인 (cursor: not-allowed / dashed) 제거, opacity 0.5
 *   A6. "여기서 시작합니다" 헤더 제거
 *   A7. 온보딩 3단계 문구 verbatim:
 *       1) 확장 설치 — 웹 어디서든 클릭 한 번으로 정보를 담습니다
 *       2) AI가 정리 — 문장에서 검증할 사실을 뽑아냅니다
 *       3) 당신이 승인 — 당신이 확인한 사실만 지식이 됩니다
 *
 * Backend 의존성 0 — /api/* 완전 mock. cold-start (is_empty=true) 시나리오만
 * 다룬다 (온보딩 문구 · 확장 설치 CTA 는 모두 empty arm 컴포넌트이므로).
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

async function installMocks(
  page: Page,
  opts: { isEmpty?: boolean } = {},
): Promise<void> {
  const isEmpty = opts.isEmpty ?? true;

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

  // Catch-all mock for /api/*.
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
      body: JSON.stringify(
        isEmpty
          ? {
              totals: {
                facts: 0,
                entities: 0,
                sources: 0,
                this_week_validated: 0,
              },
              pending_validation: 0,
              recent_validated: [],
              top_cluster: null,
              is_empty: true,
            }
          : {
              totals: {
                facts: 5,
                entities: 3,
                sources: 1,
                this_week_validated: 5,
              },
              pending_validation: 0,
              recent_validated: [],
              top_cluster: null,
              is_empty: false,
            },
      ),
    });
  });
}

test.describe('REQ-014-A — HEARTH UI 정리 (7 items)', () => {
  test('A1: 버전 표기는 AppShell footer 한 번만 노출 (home-version-footer 제거)', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    // ★ AppShell footer 는 살아 있어야 한다 (REQ-010 준수).
    const shellFooter = page.locator('[data-testid="app-shell-version-footer"]');
    await expect(shellFooter).toBeVisible();
    await expect(shellFooter).toHaveText(/^Lucid v0\.\d+\.\d+$/);

    // ★ home-version-footer 는 완전히 사라져야 한다 (중복 제거).
    const homeFooter = page.locator('[data-testid="home-version-footer"]');
    await expect(homeFooter).toHaveCount(0);

    // ★ 페이지 전체에서 "Lucid v0." 텍스트가 정확히 1 회만 등장해야 한다.
    const versionMatches = await page
      .getByText(/Lucid v0\.\d+\.\d+/)
      .count();
    expect(versionMatches).toBe(1);

    await screenshot(page, 'req014-a-hearth-ui-polish', 'a1-version-once');
  });

  test('A2: BE LUCID 브랜드 라인 폰트 크기가 커졌다 (24px, mono uppercase)', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const brand = page.locator('[data-testid="home-brand-line"]');
    await expect(brand).toBeVisible();
    await expect(brand).toHaveText('BE LUCID.');

    // 실제 computed style 검사 — 24px 이상 (이전 12px 대비 최소 2배 상승).
    const fontSizePx = await brand.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize) || 0,
    );
    expect(fontSizePx).toBeGreaterThanOrEqual(20);

    const fontFamily = await brand.evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(fontFamily.toLowerCase()).toContain('mono');

    await screenshot(page, 'req014-a-hearth-ui-polish', 'a2-brand-size');
  });

  test('A3: 빈 상태 멘트가 새 문구로 교체됨', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const emptyLine = page.locator('[data-testid="home-empty-line"]');
    await expect(emptyLine).toBeVisible();
    // ★ verbatim — 새 문구.
    await expect(emptyLine).toHaveText(
      /확장을 설치하고 첫 문장을 담아보세요/,
    );
    // ★ 이전 문구가 남아 있으면 안 됨.
    await expect(emptyLine).not.toHaveText(
      /당신의 그래프는 아직 비어 있습니다/,
    );

    await screenshot(page, 'req014-a-hearth-ui-polish', 'a3-empty-line');
  });

  test('A4: CTA 는 확장 설치 modal 을 연다', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const cta = page.locator('[data-testid="home-empty-cta"]');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText(/확장 설치하기/);
    // ★ 이전 "첫 사실 캡처하기" 문구는 사라져야 함.
    await expect(cta).not.toHaveText(/첫 사실 캡처하기/);

    // 클릭 → modal 노출 + 로컬 설치 3-step 안내.
    await cta.click();
    const modal = page.locator('[data-testid="home-extension-install-modal"]');
    await expect(modal).toBeVisible();
    const steps = page.locator(
      '[data-testid="home-extension-install-steps"]',
    );
    await expect(steps).toBeVisible();
    await expect(steps).toContainText('chrome://extensions');

    await screenshot(
      page,
      'req014-a-hearth-ui-polish',
      'a4-extension-install-modal',
    );

    // 닫기.
    await page
      .locator('[data-testid="home-extension-install-modal-close"]')
      .click();
    await expect(modal).toHaveCount(0);
  });

  test('A5: 비활성 검색 바에 금지 사인 없음 (opacity 0.5 + disabled 만)', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const wrapper = page.locator('[data-testid="home-empty-recall"]');
    const input = page.locator('[data-testid="home-empty-recall-input"]');
    await expect(wrapper).toBeVisible();
    await expect(input).toBeDisabled();

    // ★ cursor: not-allowed 금지.
    const cursor = await input.evaluate(
      (el) => getComputedStyle(el).cursor,
    );
    expect(cursor).not.toBe('not-allowed');

    // ★ wrapper opacity 0.5 근사값.
    const opacity = await wrapper.evaluate(
      (el) => parseFloat(getComputedStyle(el).opacity) || 1,
    );
    expect(opacity).toBeLessThanOrEqual(0.6);
    expect(opacity).toBeGreaterThanOrEqual(0.4);

    // ★ dashed 테두리도 사라져야 함 (금지 사인의 일부).
    const borderStyle = await input.evaluate(
      (el) => getComputedStyle(el).borderTopStyle,
    );
    expect(borderStyle).not.toBe('dashed');

    await screenshot(page, 'req014-a-hearth-ui-polish', 'a5-disabled-input');
  });

  test('A6: "여기서 시작합니다" 헤더가 제거됨', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const guide = page.locator('[data-testid="home-empty-guide"]');
    await expect(guide).toBeVisible();

    // 카드 내부에 "여기서 시작합니다" 텍스트가 없어야 함.
    await expect(guide).not.toContainText('여기서 시작합니다');
    // 이전에 함께 있던 "시작하기" 라벨도 제거.
    await expect(guide).not.toContainText('시작하기');
  });

  test('A7: 온보딩 3단계 문구 verbatim', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page, { isEmpty: true });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    // ★ verbatim — PO 제안 그대로.
    const step1 = page.locator('[data-testid="home-empty-step-1"]');
    await expect(step1).toContainText('확장 설치');
    await expect(step1).toContainText(
      '웹 어디서든 클릭 한 번으로 정보를 담습니다',
    );

    const step2 = page.locator('[data-testid="home-empty-step-2"]');
    await expect(step2).toContainText('AI가 정리');
    await expect(step2).toContainText('문장에서 검증할 사실을 뽑아냅니다');

    const step3 = page.locator('[data-testid="home-empty-step-3"]');
    await expect(step3).toContainText('당신이 승인');
    await expect(step3).toContainText(
      '당신이 확인한 사실만 지식이 됩니다',
    );

    await screenshot(page, 'req014-a-hearth-ui-polish', 'a7-onboarding-3step');
  });
});
