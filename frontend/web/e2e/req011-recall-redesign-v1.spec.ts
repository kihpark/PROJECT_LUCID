/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — Recall 재 디자인 e2e.
 *
 * Acceptance (의뢰서 §11 verbatim):
 *   1. 분석형 레이아웃 = 빈 공백 없이 (좌 렌즈 / 우 답변·근거)
 *   2. 不知 상태 = 1급 화면 완성 ("모르면 모른다 + 캡처")
 *   3. 전문용어 = 사람 언어 (정확도/대상/관계), 고급 필터 접힘
 *   4. 근거 = S-P-O 구조, 근거 그래프 호버 반응
 *   5. 예시 데이터 / 자리 = "예시·후속" 명확 표시
 *   6. Lucid 브랜드 정합 (teal, 다크, 정직성)
 *
 * ★ PO 결정 검증:
 *   1. 안심 문구 = brief.totals 실데이터 (mock totals 그대로)
 *   2. 최근 recall = v1 = 예시 (3개: 답변 2 + 不知 1)
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

async function installApiMocks(
  page: Page,
  totals: {
    facts: number;
    entities: number;
    sources: number;
    this_week_validated: number;
  } = { facts: 247, entities: 89, sources: 34, this_week_validated: 12 },
): Promise<void> {
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const token = jwt.sign(
    { sub: SEED_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
  // ★ /recall page.tsx 가 SSR 에서 cookie 의 lucid_space_id 를 읽어
  //   RecallView spaceId 를 전달한다. addInitScript 는 client-side
  //   navigation 후에만 cookie 를 설정하므로 SSR 첫 진입 시 비어 있음.
  //   → context.addCookies 로 진짜 cookie 를 사전 주입.
  const port = process.env.STELLAR_E2E_PORT
    ? Number(process.env.STELLAR_E2E_PORT)
    : 3000;
  await page.context().addCookies([
    {
      name: 'lucid_space_id',
      value: PO_KS,
      domain: 'localhost',
      path: '/',
    },
  ]);
  void port;
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

async function gotoRecallMocked(
  page: Page,
  totals?: {
    facts: number;
    entities: number;
    sources: number;
    this_week_validated: number;
  },
): Promise<void> {
  await installApiMocks(page, totals);
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
}

test.describe('REQ-011-v1 Recall 재 디자인', () => {
  test('★ Acceptance 1 — 분석형 2 단 grid 렌더', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    const root = page.getByTestId('recall-redesign-root');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('data-recall-version', 'v2-req011');

    // 좌측 렌즈 패널.
    await expect(page.getByTestId('recall-aside')).toBeVisible();
    // 우측 답변/不知 main.
    await expect(page.getByTestId('recall-main')).toBeVisible();
    // 질문 입력 + 안심 문구.
    await expect(page.getByTestId('recall-input')).toBeVisible();
    await expect(page.getByTestId('recall-scope-line')).toBeVisible();

    await screenshot(page, 'req011-recall-redesign-v1', '01-layout-grid');
  });

  test('★ PO 결정 1 — 안심 문구 = brief.totals 실데이터 (★ 하드코딩 0)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page, {
      facts: 247,
      entities: 89,
      sources: 34,
      this_week_validated: 12,
    });

    // ★ home brief totals mock 값 그대로 노출 — 시안 하드코딩 (247/89/34)
    //   가 아닌 ★ brief 응답을 그대로 받았는지 검증.
    await expect(page.getByTestId('recall-scope-facts')).toHaveText('247');
    await expect(page.getByTestId('recall-scope-entities')).toHaveText('89');
    await expect(page.getByTestId('recall-scope-sources')).toHaveText('34');
  });

  test('★ PO 결정 1-2 — brief.totals 변경 시 안심 문구 반영', async ({
    authenticatedPage: page,
  }) => {
    // 다른 mock 값으로 hardcode 가 아님 증명.
    await gotoRecallMocked(page, {
      facts: 12,
      entities: 5,
      sources: 3,
      this_week_validated: 1,
    });

    await expect(page.getByTestId('recall-scope-facts')).toHaveText('12');
    await expect(page.getByTestId('recall-scope-entities')).toHaveText('5');
    await expect(page.getByTestId('recall-scope-sources')).toHaveText('3');
  });

  test('★ Acceptance 5 — 예시 배너 default ON', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    const banner = page.getByTestId('recall-example-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('REQ-004');
    await expect(banner).toContainText('예시 데이터');

    await screenshot(page, 'req011-recall-redesign-v1', '02-example-banner');
  });

  test('★ Acceptance 5 — 예시 배너 토글', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);
    await expect(page.getByTestId('recall-example-banner')).toBeVisible();
    await page.getByTestId('recall-example-banner-toggle').click();
    await expect(page.getByTestId('recall-example-banner')).toBeHidden();
  });

  test('★ 답변 상태 — answer card + S-P-O 근거 + 미니 그래프', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    // 기본 active = q1 (SpaceX 답변).
    await expect(page.getByTestId('recall-known-panel')).toBeVisible();
    await expect(page.getByTestId('recall-query-echo')).toContainText('SpaceX');

    // ANSWER 카드.
    const answer = page.getByTestId('recall-answer-card');
    await expect(answer).toBeVisible();
    await expect(page.getByTestId('recall-answer-badge')).toHaveText('ANSWER');
    await expect(page.getByTestId('recall-answer-text')).toContainText('나스닥');

    // 정직성 한 줄.
    await expect(page.getByTestId('recall-honesty-line')).toContainText(
      '그 밖은 모릅니다',
    );

    // S-P-O 근거 카드 (★ Acceptance 4).
    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards).toHaveCount(3); // SpaceX 답변 = 사실 3건
    // 주어 클릭 가능 + 서술어 pill + 목적어.
    await expect(
      page.getByTestId('recall-evidence-subject').first(),
    ).toBeVisible();
    await expect(
      page.getByTestId('recall-evidence-predicate').first(),
    ).toBeVisible();
    await expect(
      page.getByTestId('recall-evidence-object').first(),
    ).toBeVisible();

    // 근거 그래프 canvas (★ Acceptance 4 호버 반응 대상).
    await expect(page.getByTestId('recall-mini-graph')).toBeVisible();
    await expect(page.getByTestId('recall-mini-graph-canvas')).toBeVisible();
    // 경계 노트.
    await expect(page.getByTestId('recall-boundary-note')).toContainText(
      '그래프 밖입니다',
    );

    await screenshot(page, 'req011-recall-redesign-v1', '03-answer-state');
  });

  test('★ Acceptance 2 — 不知 상태 = 1급 화면 (★ 최우선)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    // 최근 recall 의 '경계 밖' 항목 클릭 → 不知 상태로 전환.
    await page.getByTestId('recall-recent-unknown').click();

    const unknown = page.getByTestId('recall-unknown-state');
    await expect(unknown).toBeVisible();

    // 질문 인용.
    await expect(page.getByTestId('recall-unknown-question')).toContainText(
      '테슬라 4분기 실적',
    );
    // 검증된 영역 ↔ 그래프 밖 대비.
    await expect(page.getByTestId('recall-unknown-verified')).toBeVisible();
    await expect(page.getByTestId('recall-unknown-outside')).toBeVisible();
    // ★ PO 결정 1 — 不知 대비 카드도 brief.totals 사용.
    await expect(page.getByTestId('recall-unknown-facts-count')).toHaveText(
      '247',
    );
    await expect(page.getByTestId('recall-unknown-entities-count')).toHaveText(
      '89',
    );
    // 선언 + CTA.
    await expect(page.getByTestId('recall-unknown-declaration')).toContainText(
      '그래프 밖입니다',
    );
    await expect(page.getByTestId('recall-unknown-cta-capture')).toContainText(
      '캡처해서 검증하기',
    );
    await expect(
      page.getByTestId('recall-unknown-cta-ask-again'),
    ).toContainText('다른 질문하기');

    await screenshot(page, 'req011-recall-redesign-v1', '04-unknown-state');
  });

  test('★ 최근 recall 클릭 → 우 패널 전환 (상태 스위칭)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    // 시작 = q1 답변.
    await expect(page.getByTestId('recall-known-panel')).toBeVisible();
    await expect(page.getByTestId('recall-recent-q1')).toHaveAttribute(
      'data-active',
      'true',
    );

    // q2 클릭 → 답변 전환.
    await page.getByTestId('recall-recent-q2').click();
    await expect(page.getByTestId('recall-recent-q2')).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.getByTestId('recall-query-echo')).toContainText(
      '바이오빅데이터',
    );

    // unknown 클릭 → 不知 전환.
    await page.getByTestId('recall-recent-unknown').click();
    await expect(page.getByTestId('recall-unknown-state')).toBeVisible();
    await expect(page.getByTestId('recall-known-panel')).toBeHidden();

    // 다시 q1 → 답변 복귀.
    await page.getByTestId('recall-recent-q1').click();
    await expect(page.getByTestId('recall-known-panel')).toBeVisible();
    await expect(page.getByTestId('recall-unknown-state')).toBeHidden();
  });

  test('★ Acceptance 3 — 고급 필터 default 접힘 + 토글', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    // 고급 default 접힘.
    await expect(page.getByTestId('recall-advanced-panel')).toBeHidden();
    // 펼침.
    await page.getByTestId('recall-advanced-toggle').click();
    await expect(page.getByTestId('recall-advanced-panel')).toBeVisible();
    // 다시 접힘.
    await page.getByTestId('recall-advanced-toggle').click();
    await expect(page.getByTestId('recall-advanced-panel')).toBeHidden();
  });

  test('★ Acceptance 3 — 사람 언어 (대상/관계) 패섯', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecallMocked(page);

    const entitiesPanel = page.getByTestId('recall-facet-entities');
    const predicatesPanel = page.getByTestId('recall-facet-predicates');
    await expect(entitiesPanel).toBeVisible();
    await expect(predicatesPanel).toBeVisible();
    // ★ "엔티티" / "서술어" 같은 전문용어 X — 의뢰서 §3-5 verbatim
    //   "대상 / 관계" 만 사용.
    await expect(page.locator('aside[data-testid="recall-aside"]'))
      .toContainText('대상');
    await expect(page.locator('aside[data-testid="recall-aside"]'))
      .toContainText('관계');
    // 시안 verbatim 자연어 predicate.
    await expect(predicatesPanel).toContainText('상장하다');
    await expect(predicatesPanel).toContainText('개최하다');
  });
});
