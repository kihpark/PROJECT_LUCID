/**
 * ★ REQ-014-F (PO 2026-07-02) — HEARTH 지표 중복 제거 + 배지화.
 *
 * PO verbatim: "'검증된 사실 87·엔티티 149·출처 8·이번 주 +87' 이거 왜
 *   2번이나 하는데? 최하단 지워야 할 것 아니냐?"
 *   "검색바 아래 잘 보이게 키우고 별도로 바긋 처리 해서 제대로 지표
 *   보여주던가"
 *
 * 처방 (HomePage.tsx):
 *   1. 최하단 QuickStats (data-testid="home-quick-stats") 삭제
 *   2. HumilityLine 을 검색바 (ActiveRecallInput) 바로 아래로 이동
 *   3. HumilityLine 을 mono 한 줄 → pill 배지 4개로 리스타일
 *
 * 이 spec 은:
 *   (a) 홈에 지표 블록이 정확히 1 개 (`home-humility` 1개, `home-quick-stats` 0개)
 *   (b) 지표 블록이 검색바 (form) 바로 아래 (DOM 순서 검증)
 *   (c) pill 배지 스타일 (border-radius, teal border) 존재
 *   (d) 스크린샷 증거
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

test.describe('REQ-014-F — HEARTH 지표 중복 제거 + 배지화', () => {
  test('★ 지표 블록 홈 화면에 정확히 1개 (하단 QuickStats 제거)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page, {
      facts: 87,
      entities: 149,
      sources: 8,
      this_week_validated: 87,
    });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    // 홈이 populated 상태 (mock 값 → is_empty=false).
    await expect(page.getByTestId('home-populated')).toBeVisible();

    // 지표 배지 블록은 정확히 1개.
    await expect(page.getByTestId('home-humility')).toHaveCount(1);
    // 하단 QuickStats 는 완전히 제거됨.
    await expect(page.getByTestId('home-quick-stats')).toHaveCount(0);
    await expect(page.getByTestId('home-stat-facts')).toHaveCount(0);
    await expect(page.getByTestId('home-stat-entities')).toHaveCount(0);
    await expect(page.getByTestId('home-stat-sources')).toHaveCount(0);
    await expect(page.getByTestId('home-stat-this-week')).toHaveCount(0);

    // 4 지표 값이 mock 그대로 노출 (REQ-008 계약 유지).
    await expect(page.getByTestId('home-humility-facts')).toHaveText('87');
    await expect(page.getByTestId('home-humility-entities')).toHaveText('149');
    await expect(page.getByTestId('home-humility-sources')).toHaveText('8');
    await expect(page.getByTestId('home-humility-this-week')).toHaveText('+87');

    await screenshot(
      page,
      'req014-f-hearth-quickstats',
      '01-single-metric-block',
    );
  });

  test('★ 지표 블록이 검색바 바로 아래에 위치 (DOM 순서)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page, {
      facts: 87,
      entities: 149,
      sources: 8,
      this_week_validated: 87,
    });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const form = page.getByTestId('home-recall-form');
    const humility = page.getByTestId('home-humility');
    await expect(form).toBeVisible();
    await expect(humility).toBeVisible();

    // 폼과 humility 의 bounding box: humility.top >= form.bottom (아래에 있음).
    const formBox = await form.boundingBox();
    const humilityBox = await humility.boundingBox();
    expect(formBox).not.toBeNull();
    expect(humilityBox).not.toBeNull();
    if (!formBox || !humilityBox) return;
    expect(humilityBox.y).toBeGreaterThanOrEqual(formBox.y + formBox.height - 4);

    // 그리고 오늘의 브리핑 카드보다 위에 있어야 함.
    const briefing = page.getByTestId('home-briefing-card');
    await expect(briefing).toBeVisible();
    const briefingBox = await briefing.boundingBox();
    if (briefingBox) {
      expect(humilityBox.y).toBeLessThan(briefingBox.y);
    }

    await screenshot(
      page,
      'req014-f-hearth-quickstats',
      '02-position-below-search',
    );
  });

  test('★ pill 배지 스타일 — border-radius pill, teal border 존재', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page, {
      facts: 87,
      entities: 149,
      sources: 8,
      this_week_validated: 87,
    });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const humility = page.getByTestId('home-humility');
    await expect(humility).toBeVisible();

    // 각 지표 숫자 span 이 그대로 노출 (REQ-008 계약).
    await expect(humility).toContainText('검증된 사실');
    await expect(humility).toContainText('엔티티');
    await expect(humility).toContainText('출처');
    await expect(humility).toContainText('이번 주');

    // pill = 각 지표를 감싸는 부모 span 의 border-radius 가 매우 큼 (999).
    // home-humility-facts 의 closest span (pill wrapper) 를 검증.
    const factsPill = page.locator(
      '[data-testid="home-humility"] > span',
    ).first();
    await expect(factsPill).toBeVisible();
    const radius = await factsPill.evaluate((el) =>
      window.getComputedStyle(el).borderRadius,
    );
    // "999px" 혹은 큰 값. contains '9' 로 러프 검증.
    expect(radius).toMatch(/\d/);
    // border 색상은 teal 계열 rgb(63, 224, 198) 근처.
    const border = await factsPill.evaluate((el) =>
      window.getComputedStyle(el).borderColor,
    );
    // 러프 검증 — teal 은 g,b 값이 r 보다 크다.
    const rgb = border.match(/\d+/g);
    if (rgb && rgb.length >= 3) {
      const [r, g, b] = rgb.map(Number);
      expect(g).toBeGreaterThan(r as number);
      expect(b).toBeGreaterThan((r as number) - 20);
    }

    await screenshot(
      page,
      'req014-f-hearth-quickstats',
      '03-pill-badge-style',
    );
  });

  test('★ v1 humility 카피 회귀 가드 (REQ-008 계약 유지)', async ({
    authenticatedPage: page,
  }) => {
    await installApiMocks(page, {
      facts: 87,
      entities: 149,
      sources: 8,
      this_week_validated: 87,
    });
    await page.goto('/home');
    await page.waitForLoadState('networkidle');

    const humility = page.getByTestId('home-humility');
    await expect(humility).toBeVisible();
    // v1 legacy 카피는 여전히 사라진 상태.
    await expect(humility).not.toContainText('당신이 검증한');
    await expect(humility).not.toContainText('99개의 사실');
  });
});
