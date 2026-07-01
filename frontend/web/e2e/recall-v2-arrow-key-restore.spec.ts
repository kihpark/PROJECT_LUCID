/**
 * ★ recall-v2-autocomplete-arrow-restore (PO 2026-07-01) — RecallView v2 의
 * 자동완성 dropdown 화살표 키 조작 복원 회귀 가드.
 *
 * 배경 (PO dogfood verbatim):
 *   "리콜에서 검색어 입력했을 때 자동 추천 뜰 때 사용자가 아래 화살표 키
 *    눌러도 내려가질 않는다."
 *
 * 옛 RecallView (v1 pre-redesign) 의 SearchBar 에는 ArrowDown/Up/Enter/Escape
 * keyboard handler 가 있었으나 REQ-011-v1 재작성 시 미보존, REQ-011-v2 실
 * 검색 도입 후에도 복원되지 않음. 본 spec 은 다음 회귀를 잡는다:
 *
 *   1. dropdown 열려 있는 상태에서 ArrowDown 누르면 activeSuggestionIdx 가
 *      0, 1, 2, ... 로 내려간다 (data-active="true" 로 관찰).
 *   2. ArrowUp 누르면 idx 가 다시 위로 올라간다.
 *   3. Enter (idx >= 0) → 그 suggestion 의 primary_label 로 실 검색이 실행
 *      되어 답변 또는 不知 상태가 등장한다 (recall-input value 도 갱신).
 *   4. Escape 누르면 dropdown 닫힌다.
 *
 * Backend 의존성 0 — page.route() 로 API mock. 실 검색 성공 케이스는 recall
 * mock 에 fact 1개 응답 + brief mock 도 inference 응답.
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

  // catchall — LAST registered wins 규칙에 맞게 먼저 등록.
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

  // ★ 3 건 suggestion. 화살표 이동 관찰용으로 최소 2 개 이상 필요.
  await page.route(/\/api\/spaces\/.+\/entities\/suggest/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        items: [
          {
            entity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            primary_label: '박원갑',
            primary_lang: 'ko',
            score: 0.95,
          },
          {
            entity_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            primary_label: '박기흥',
            primary_lang: 'ko',
            score: 0.9,
          },
          {
            entity_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            primary_label: '박정희',
            primary_lang: 'ko',
            score: 0.85,
          },
        ],
      }),
    });
  });

  // ★ recall 실 응답 — fact 1건. 화살표 Enter → 실 검색 실행 확인.
  await page.route(/\/api\/spaces\/.+\/recall\b/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        query: '박기흥',
        facts: [
          {
            fact_uid: '99999999-9999-4999-8999-999999999999',
            fact_type: 'entity_relation',
            subject_uid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            subject_label: '박기흥',
            subject_entity_type: 'person',
            predicate: 'works_at',
            predicate_label: '소속',
            object_uid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            object_label: 'CMU',
            object_value: 'CMU',
            source_uids: ['s1'],
            valid_from: null,
            valid_to: null,
            confidence: 0.9,
          },
        ],
        hits: 1,
      }),
    });
  });

  // ★ HEARTH assistant brief — fail-soft 로 fallback 도 되지만 여기선 정상 응답.
  await page.route(/\/api\/assistant\/brief\b/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        inference: '박기흥은 CMU 에 소속되어 있습니다.',
        verified_facts: [],
      }),
    });
  });
}

test.describe('recall-v2-autocomplete-arrow-restore — 화살표 키 조작', () => {
  test('★ ArrowDown 2 번 → 2 번째 suggestion 활성', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await expect(input).toBeVisible();
    await input.focus();
    await input.fill('박');
    await page.waitForTimeout(400); // debounce + fetch.

    const dropdown = page.getByTestId('recall-suggest-dropdown');
    await expect(dropdown).toBeVisible();
    const items = page.getByTestId('recall-suggest-item');
    await expect(items).toHaveCount(3);

    // ★ 초기 상태: 활성 없음.
    for (let i = 0; i < 3; i += 1) {
      await expect(items.nth(i)).toHaveAttribute('data-active', 'false');
    }

    await screenshot(
      page,
      'recall-v2-arrow-key-restore',
      '01-initial-no-active',
    );

    // ArrowDown 1 번 → 첫 번째 활성.
    await input.press('ArrowDown');
    await expect(items.nth(0)).toHaveAttribute('data-active', 'true');
    await expect(items.nth(1)).toHaveAttribute('data-active', 'false');

    // ArrowDown 2 번째 → 두 번째 활성.
    await input.press('ArrowDown');
    await expect(items.nth(0)).toHaveAttribute('data-active', 'false');
    await expect(items.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(items.nth(2)).toHaveAttribute('data-active', 'false');

    await screenshot(
      page,
      'recall-v2-arrow-key-restore',
      '02-arrow-down-twice',
    );
  });

  test('★ ArrowUp 이 활성 index 를 감소시킨다', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await input.focus();
    await input.fill('박');
    await page.waitForTimeout(400);

    const items = page.getByTestId('recall-suggest-item');
    await expect(items).toHaveCount(3);

    // 3번 내려가 idx=2 로.
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expect(items.nth(2)).toHaveAttribute('data-active', 'true');

    // 1번 위로 → idx=1.
    await input.press('ArrowUp');
    await expect(items.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(items.nth(2)).toHaveAttribute('data-active', 'false');

    await screenshot(
      page,
      'recall-v2-arrow-key-restore',
      '03-arrow-up-decreases',
    );

    // 계속 위 눌러도 0 이하로 안 내려간다.
    await input.press('ArrowUp');
    await input.press('ArrowUp');
    await input.press('ArrowUp');
    await expect(items.nth(0)).toHaveAttribute('data-active', 'true');
  });

  test('★ Enter (활성 idx >= 0) → 그 suggestion 라벨로 검색 실행', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await input.focus();
    await input.fill('박');
    await page.waitForTimeout(400);

    const items = page.getByTestId('recall-suggest-item');
    await expect(items).toHaveCount(3);

    // 2번째 (박기흥) 활성화.
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expect(items.nth(1)).toHaveAttribute('data-active', 'true');

    // Enter → 그 라벨로 검색.
    await input.press('Enter');

    // dropdown 닫힘, input value = 박기흥, 실 검색 결과 known 패널 등장.
    await expect(page.getByTestId('recall-suggest-dropdown')).toBeHidden();
    await expect(input).toHaveValue('박기흥');
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible({
      timeout: 3000,
    });
    await expect(page.getByTestId('recall-query-echo')).toContainText('박기흥');

    await screenshot(
      page,
      'recall-v2-arrow-key-restore',
      '04-enter-picks-and-searches',
    );
  });

  test('★ Escape → dropdown 닫힘', async ({ authenticatedPage: page }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await input.focus();
    await input.fill('박');
    await page.waitForTimeout(400);

    await expect(page.getByTestId('recall-suggest-dropdown')).toBeVisible();
    await input.press('Escape');
    await expect(page.getByTestId('recall-suggest-dropdown')).toBeHidden();

    await screenshot(
      page,
      'recall-v2-arrow-key-restore',
      '05-escape-closes',
    );
  });

  test('★ Enter (활성 idx = -1) → raw query 로 검색 (기존 동작 보존)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    const input = page.getByTestId('recall-input');
    await input.focus();
    await input.fill('박기흥');
    await page.waitForTimeout(400);

    // dropdown 열려 있어도 화살표 미사용 상태 → idx = -1.
    // Enter 는 raw query 검색 (기존 onSubmit 동작 그대로).
    await expect(page.getByTestId('recall-suggest-dropdown')).toBeVisible();
    await input.press('Enter');

    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible({
      timeout: 3000,
    });
    await expect(page.getByTestId('recall-query-echo')).toContainText('박기흥');
  });
});
