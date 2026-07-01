/**
 * ★ REQ-007-v3 (2026-07-01) — HEARTH Sphere PO 3 dogfood 이슈 e2e.
 *
 * PO 의뢰:
 *   1. sphere 사각 경계 여전히 보임 → canvas 뷰포트 전체 확장, 배경
 *      transparent, halo gradient 대각선 55% 까지 → 경계 사라짐.
 *   2. hover 좁은 사각형 → pointer event window level, 뷰포트 어디를
 *      hover 하든 코어 반응.
 *   3. speaking 과도한 정신사나움 → TARGET_PARAMS.speaking breathe/bright
 *      하향 (spin/pull/wave 존재감 유지).
 *
 * Backend 의존성 0 — page.route() 로 /api/* mock (v2 spec 패턴 재사용).
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

async function installApiMocks(
  page: Page,
  opts: { assistantDelayMs?: number } = {},
): Promise<void> {
  const delayMs = opts.assistantDelayMs ?? 1200;

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
        totals: {
          facts: 247,
          entities: 89,
          sources: 34,
          this_week_validated: 12,
        },
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });

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

test.describe('REQ-007-v3 HEARTH sphere — 3 PO dogfood 이슈', () => {
  test('★ Issue 1 + 2: canvas = 뷰포트 전체 + pointer scope viewport', async ({
    authenticatedPage: page,
  }) => {
    await gotoHomeMocked(page);

    // ★ v3 마커 — v2 회귀 가드.
    const wrapper = page.locator(WRAPPER);
    await expect(wrapper).toHaveAttribute('data-hearth-version', 'v3');
    await expect(wrapper).toHaveAttribute('data-hearth-hover-scope', 'viewport');

    // ★ Issue 1: canvas element 가 뷰포트 전체 크기 (position: fixed).
    const canvas = page.locator(CANVAS);
    await expect(canvas).toBeAttached();
    const box = await canvas.boundingBox();
    const vp = page.viewportSize();
    expect(box).not.toBeNull();
    expect(vp).not.toBeNull();
    // 뷰포트 전체 = width/height 각각 ≥ 99% (round 오차 허용).
    expect(box!.width).toBeGreaterThanOrEqual(vp!.width * 0.99);
    expect(box!.height).toBeGreaterThanOrEqual(vp!.height * 0.99);

    // ★ canvas 자체 배경 = transparent (사각 경계 원인 제거 검증).
    const bg = await canvas.evaluate((el) => getComputedStyle(el).background);
    // computed style 은 브라우저별 형식 차이 — rgba(0,0,0,0) 또는
    // "transparent" 또는 "none" 포함이면 OK.
    expect(bg).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)|transparent|none/);

    // ★ canvas 는 pointer-events: none (아래 UI 클릭 통과).
    const pe = await canvas.evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pe).toBe('none');

    // ★ position: fixed (뷰포트 고정).
    const pos = await canvas.evaluate((el) => getComputedStyle(el).position);
    expect(pos).toBe('fixed');

    await screenshot(page, 'req007v3-hearth-boundary', '01-canvas-viewport-full');
  });

  test('★ Issue 2: 뷰포트 모서리에서도 pointer event → 코어 반응', async ({
    authenticatedPage: page,
  }) => {
    await gotoHomeMocked(page);
    const vp = page.viewportSize()!;

    // 뷰포트 좌측 상단 모서리로 마우스 이동 (canvas 밖처럼 보이는 위치).
    // v2 이하: 이 위치는 좁은 정사각 canvas 밖 → pointer 무반응.
    // v3: window pointermove → 반응.
    await page.mouse.move(10, 10);
    await page.waitForTimeout(200);
    await screenshot(page, 'req007v3-hearth-boundary', '02-hover-top-left');

    // 우측 하단 모서리.
    await page.mouse.move(vp.width - 10, vp.height - 10);
    await page.waitForTimeout(200);
    await screenshot(page, 'req007v3-hearth-boundary', '03-hover-bottom-right');

    // 원점 (중앙 근처).
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.waitForTimeout(200);
    await screenshot(page, 'req007v3-hearth-boundary', '04-hover-center');

    // 입력 필드 클릭 가능성 — pointer-events: none 이 canvas 위에서 통과.
    const input = page.locator(INPUT);
    await input.click(); // 성공 = pointer 통과 검증.
    await expect(input).toBeFocused();
  });

  test('★ Issue 3: speaking TARGET_PARAMS 진정 (breathe/bright ↓, spin/pull/wave 유지)', async ({
    authenticatedPage: page,
  }) => {
    await gotoHomeMocked(page, { assistantDelayMs: 500 });

    // TARGET_PARAMS.speaking 값 검증 — 브라우저에서 import 하여 확인.
    // 페이지 로드 후 window 전역에는 노출 안 됨 → 코드 export 통해 검증
    // 대신 rendered 상태의 params contract 를 e2e 관점에서 검증.
    // ★ 여기선 attribute 만 pin (jsdom 단위 테스트가 값 자체 검증).

    const input = page.locator(INPUT);
    await input.focus();
    await input.fill('검증된 사실은 무엇인가요');
    await page.locator(SUBMIT).click();

    // speaking 상태 도달.
    await expect(page.locator(CANVAS)).toHaveAttribute('data-state', 'speaking', {
      timeout: 10_000,
    });
    // lerp 안정화 대기.
    await page.waitForTimeout(1200);
    await screenshot(page, 'req007v3-hearth-boundary', '05-state-speaking-calm');
  });

  test('★ Issue 1 시각 회귀: idle 상태에서 캔버스 경계 스크린샷', async ({
    authenticatedPage: page,
  }) => {
    await gotoHomeMocked(page);
    await expect(page.locator(CANVAS)).toHaveAttribute('data-state', 'idle');
    // 마우스 화면 밖으로 (모서리로) — 정면 idle 캡처.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(600);
    await screenshot(page, 'req007v3-hearth-boundary', '06-idle-no-boundary');
  });
});
