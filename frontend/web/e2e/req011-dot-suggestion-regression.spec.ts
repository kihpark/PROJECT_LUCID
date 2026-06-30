/**
 * ★ M-Dogfood-C (PO 2026-07-01) — REQ-011 신규 RecallView 의 자동완성
 * dropdown 에 "." 같은 무의미 라벨 0 회귀 가드.
 *
 * 배경 (PO verbatim):
 *   "자동추천 '.' 재발 = 회귀. 재fix + 회귀 가드 spec".
 *
 * 옛 fix (api.ts::isMeaningfulLabel) 는 RecallView 옛 SearchBar 의 호출부에만
 * 적용됐다. REQ-011 의 신규 디자인 (recall-input) 이 도입되면서 자동완성
 * 자체가 일시 제거 → "fix 가 묶이지 않은 새 화면" 이 생긴 셈. PO 의뢰서
 * verbatim: "옛 SearchBar 신규 디자인에 isMeaningfulLabel".
 *
 * 본 spec 의 회귀 가드:
 *   1. backend mock 이 "." 항목을 응답에 끼워 줘도 (회귀: 백엔드 필터가 깨졌
 *      다는 시나리오) RecallView dropdown 에 "." 가 노출되지 않는다.
 *   2. 다른 정상 entity (예: "박원갑") 는 정상 표시 (필터 과도 가드 0).
 *   3. dropdown 항목의 텍스트는 \p{L}\p{N} 가 한 글자 이상 — 구두점·공백만
 *      으로 구성된 라벨이 절대 통과하지 못한다 (★ 케이스 하드코딩 X — 원칙).
 *
 * Backend 의존성 0 — page.route() 로 /api/.../entities/suggest mock.
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

  // ★ Playwright route priority: LAST registered wins. catchall 먼저,
  //   specific 뒤. (req011-recall-redesign-v1.spec.ts 와 동일 순서.)
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
        totals: { facts: 12, entities: 5, sources: 3, this_week_validated: 1 },
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });

  // ★ 핵심 — backend regression 시뮬레이션. "." 라벨이 응답에 끼어 있어도
  //   frontend isMeaningfulLabel 가드가 dropdown 에 노출 0.
  await page.route(/\/api\/spaces\/.+\/entities\/suggest/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        items: [
          // 회귀 케이스 1: 단독 ".".
          {
            entity_id: '11111111-1111-4111-8111-111111111111',
            primary_label: '.',
            primary_lang: 'ko',
            score: 0.95,
          },
          // 회귀 케이스 2: "..." (구두점만).
          {
            entity_id: '22222222-2222-4222-8222-222222222222',
            primary_label: '...',
            primary_lang: 'ko',
            score: 0.9,
          },
          // 회귀 케이스 3: 공백만.
          {
            entity_id: '33333333-3333-4333-8333-333333333333',
            primary_label: '   ',
            primary_lang: 'ko',
            score: 0.85,
          },
          // 정상 케이스 — 필터 과도 가드 (이 항목은 반드시 표시).
          {
            entity_id: '44444444-4444-4444-8444-444444444444',
            primary_label: '박원갑',
            primary_lang: 'ko',
            score: 0.8,
          },
          {
            entity_id: '55555555-5555-4555-8555-555555555555',
            primary_label: 'SpaceX',
            primary_lang: 'en',
            score: 0.78,
          },
        ],
      }),
    });
  });
}

test.describe('M-Dogfood-C — recall-input 자동완성 회귀 가드', () => {
  test('★ "." regression — backend 가 "." 흘려도 dropdown 노출 0', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await expect(input).toBeVisible();

    // 의미 있는 글자를 입력 (★ 회귀 backend mock 이 5건 응답 — 그 중 3건
    // 이 무의미 라벨, 2건 이 의미 있는 라벨).
    await input.fill('박');
    // debounce 200ms + suggestion fetch.
    await page.waitForTimeout(400);

    const dropdown = page.getByTestId('recall-suggest-dropdown');
    await expect(dropdown).toBeVisible();

    const items = page.getByTestId('recall-suggest-item');
    const count = await items.count();
    // ★ 무의미 라벨 3건 모두 제거되고 2건만 남아야.
    expect(count).toBe(2);

    // ★ 원칙 단위 검증 — case 하드코딩 X. 어떤 항목이든 글자/숫자 1개 이상.
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      const text = (await item.textContent())?.trim() ?? '';
      expect(text).not.toBe('.');
      expect(text).not.toBe('...');
      expect(text.length).toBeGreaterThan(0);
      // \p{L} = letter, \p{N} = number — Hangul / Latin / 숫자 등.
      expect(/[\p{L}\p{N}]/u.test(text)).toBe(true);
    }

    await screenshot(
      page,
      'req011-dot-suggestion-regression',
      '01-dropdown-no-dot',
    );
  });

  test('★ 정상 라벨은 정상 표시 (필터 과도 가드)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await input.fill('박');
    await page.waitForTimeout(400);

    // 박원갑은 person 회귀 가드의 핵심 fixture.
    await expect(
      page.getByTestId('recall-suggest-item').filter({ hasText: '박원갑' }),
    ).toBeVisible();

    await screenshot(
      page,
      'req011-dot-suggestion-regression',
      '02-valid-label-shows',
    );
  });

  test('★ data-primary-label 속성 가드 — 무의미 라벨 0', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('recall-input').fill('박');
    await page.waitForTimeout(400);

    const items = page.getByTestId('recall-suggest-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const label = await items.nth(i).getAttribute('data-primary-label');
      expect(label).not.toBeNull();
      const trimmed = (label ?? '').trim();
      expect(trimmed).not.toBe('.');
      expect(trimmed).not.toBe('...');
      expect(/[\p{L}\p{N}]/u.test(trimmed)).toBe(true);
    }
  });
});
