/**
 * ★ REQ-007-v1 (2026-06-30) — HEARTH Sphere 입자 코어 4 상태 e2e.
 *
 * Acceptance (PO 직접 — screenshot 증거):
 *   1. 4 상태 (idle / listening / thinking / speaking) 렌더 + data-state attr
 *   2. 실제 Q&A 라이프사이클 동기:
 *        idle      = 입력 전 / blur / 빈 input
 *        listening = 입력 포커스 또는 타이핑 중
 *        thinking  = API 응답 대기 중 (in-flight)
 *        speaking  = 응답 mount 됨
 *   3. screenshot 4 장 (4 상태) 증거
 *
 * Backend 의존성 0 — page.route() 로 /api/* 완전 mock:
 *   - /api/auth/me → display_name + default_space_id
 *   - /api/home/brief → populated (facts > 0) → HomePopulated arm
 *   - /api/assistant/brief → ★ thinking → speaking 시연을 위해 의도적
 *     delay (1.2s) 후 grounded 응답
 */
import { test, expect, PO_KS } from './fixtures/auth';
import type { Page } from '@playwright/test';
import { screenshot } from './helpers/req004Flow';

const CANVAS = '[data-testid="hearth-sphere-canvas"]';
const WRAPPER = '[data-testid="home-sphere"]';
const INPUT = '[data-testid="home-recall-input"]';
const SUBMIT = '[data-testid="home-recall-submit"]';

const SEED_USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/** ★ Full /api/* mock — backend 없이 HEARTH 입력 활성화 + thinking →
 * speaking 시연. assistantDelayMs 로 thinking 체류 시간 제어. */
async function installApiMocks(
  page: Page,
  opts: { assistantDelayMs?: number } = {},
): Promise<void> {
  const delayMs = opts.assistantDelayMs ?? 1200;

  // 1. localStorage / cookie seed.
  //    - lucid_space_id : space id (assistantBrief space param)
  //    - lucid_jwt      : ★ isAuthenticated() 가 localStorage 만 본다.
  //      fixtures/auth.ts 는 cookie 만 심으므로 mirror 필요.
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

  // 2. /api/* catchall (registered first → lowest precedence).
  await page.route(/\/api\//, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: '{}',
    });
  });

  // 3. /api/auth/me — display_name + default_space_id (★ field 정합).
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

  // 4. /api/home/brief — populated → HomePopulated arm + recall input.
  await page.route(/\/api\/home\/brief(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
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
      }),
    });
  });

  // 5. /api/assistant/brief — ★ 의도적 delay (thinking 가시화) 후 grounded 응답.
  await page.route(/\/api\/assistant\/brief(\?.*)?$/, async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        kind: 'grounded',
        query: '테스트',
        verified_facts: [
          {
            fact_uid: 'seed-1',
            claim: '검증된 사실 예시',
            sources: [],
            score: 1.0,
          },
        ],
        inference: null,
      }),
    });
  });
}

async function gotoHomeMocked(
  page: Page,
  opts?: { assistantDelayMs?: number },
): Promise<void> {
  await installApiMocks(page, opts);
  await page.goto('/home');
  await page.waitForLoadState('networkidle');
}

test.describe('REQ-007 HEARTH sphere 입자 코어 4 상태', () => {
  test('canvas mount + 기본 idle 상태', async ({ authenticatedPage: page }) => {
    await gotoHomeMocked(page);

    // ★ canvas mount + data-state attr.
    const canvas = page.locator(CANVAS);
    await expect(canvas).toBeAttached();
    await expect(canvas).toHaveAttribute('data-state', 'idle');

    // ★ wrapper backwards-compat.
    const wrapper = page.locator(WRAPPER);
    await expect(wrapper).toHaveAttribute('data-sphere-state', 'idle');
    await expect(wrapper).toHaveAttribute('data-hearth-sphere', 'particle-core');

    await screenshot(page, 'req007-hearth-sphere', '01-idle');
  });

  test('listening: 입력 포커스 → state listening', async ({
    authenticatedPage: page,
  }) => {
    await gotoHomeMocked(page);

    const input = page.locator(INPUT);
    await expect(input).toBeVisible();

    await input.focus();
    // ★ onFocus handler → setSphereState('listening') 동기 호출.
    await expect(page.locator(CANVAS)).toHaveAttribute('data-state', 'listening');

    // ★ 타이핑 후에도 listening 유지 (handleChange 가 length>0 일 때 listening).
    await input.fill('테스트 질문입니다');
    await expect(page.locator(CANVAS)).toHaveAttribute('data-state', 'listening');

    await screenshot(page, 'req007-hearth-sphere', '02-listening');
  });

  test('thinking: submit → API 응답 대기 시 thinking 진입', async ({
    authenticatedPage: page,
  }) => {
    // ★ 1.5s delay — thinking 충분히 가시화.
    await gotoHomeMocked(page, { assistantDelayMs: 1500 });

    const input = page.locator(INPUT);
    await expect(input).toBeVisible();
    await input.focus();
    await input.fill('검증된 사실은 무엇인가요');

    // submit 와 동시에 thinking 진입 — onSphereState('thinking') 동기 호출.
    await Promise.all([
      page.locator(SUBMIT).click(),
      expect(page.locator(CANVAS)).toHaveAttribute('data-state', 'thinking', {
        timeout: 2000,
      }),
    ]);

    await screenshot(page, 'req007-hearth-sphere', '03-thinking');
  });

  test('speaking: 응답 mount 후 speaking 진입', async ({
    authenticatedPage: page,
  }) => {
    await gotoHomeMocked(page, { assistantDelayMs: 600 });

    const input = page.locator(INPUT);
    await expect(input).toBeVisible();
    await input.focus();
    await input.fill('검증된 사실은 무엇인가요');
    await page.locator(SUBMIT).click();

    // AssistantQuery 가 응답 mount → onStateChange('speaking').
    await expect(page.locator(CANVAS)).toHaveAttribute('data-state', 'speaking', {
      timeout: 10_000,
    });

    await screenshot(page, 'req007-hearth-sphere', '04-speaking');
  });
});
