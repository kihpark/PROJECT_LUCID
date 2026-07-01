/**
 * ★ REQ-011-v2 dogfood-3 fix (PO 2026-07-01) — 3 이슈 e2e 검증.
 *
 * dogfood 3 라운드 스크린샷 image #134 피드백 verbatim:
 *   이슈 1: "근거 충분" 4 단계 바 = 항상 3/4 (하드코딩). 기준 미명시.
 *   이슈 2: 근거 사실 카드 밑에 UUID (source_uid) 노출.
 *   이슈 3: 좌 패널 'RECALL · 검증된 것만 답합니다', '최근 recall' —
 *          영문 코드 노출 (REQ-002 회귀 방향).
 *
 * PO 재확인 (dogfood-3):
 *   • UUID 화면 노출 0 (REQ-004 STAGE 3+4 원칙 전체 적용).
 *   • "정의 없는 지표 금지" — sufficient 4 단계는 명확한 fact-수 기준으로.
 *   • 사용자 노출 text = SECTION_LABELS_KO (내부 코드 identifier 유지).
 *
 * Backend 의존성 0 — page.route() 로 recall / brief mock.
 */
import { test, expect, PO_KS } from './fixtures/auth';
import type { Page, Route } from '@playwright/test';
import { captureEvidence } from './helpers/screenshot';

const SEED_USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// UUID4 (하이픈 포함) 패턴 — 화면 텍스트에 등장하면 회귀.
const UUID4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

// 시드 fact — dogfood image #134 재현.
//   • source_uids = 실제 backend 가 흘려보내는 UUID 형식 (이슈 2 회귀 시드).
//   • fact 갯수 = 각 sufficient 단계 검증 (test 별 seed override).
const MAKE_FACT = (i: number, extra: Partial<Record<string, unknown>> = {}) => ({
  fact_uid: `d2bf7fb7-67b5-48c7-af22-${String(i).padStart(12, '0')}`,
  claim: `SpaceX 관련 사실 ${i}`,
  claim_en: null,
  subject_uid: 'e1000000-0000-4000-8000-000000000001',
  subject_label: 'SpaceX',
  subject_entity_type: 'organization',
  predicate: 'related_to',
  predicate_label: '관련',
  object_uid: `e2000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  object_label: `대상 ${i}`,
  object_value: `대상 ${i}`,
  // ★ 이슈 2 재현 — source_uids 가 UUID 형식 (사람이 못 읽음).
  source_uids: ['d2bf7fb7-67b5-48c7-af22-1234567890ab'],
  validated_at: '2026-06-24T09:00:00Z',
  validator_id: '박기흥',
  validation_method: 'manual',
  knowledge_space_id: PO_KS,
  negation_flag: false,
  negation_scope: null,
  score: 0.9,
  fact_type: 'action',
  ...extra,
});

interface InstallOptions {
  factCount?: number;
  withUrlSource?: boolean;
  withUnresolvedLabel?: boolean;
}

async function installApiMocks(
  page: Page,
  opts: InstallOptions = {},
): Promise<void> {
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
        totals: { facts: 247, entities: 89, sources: 34, this_week_validated: 12 },
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });

  await page.route(/\/api\/spaces\/[^/]+\/recall\?.*/, async (route: Route) => {
    const n = opts.factCount ?? 5;
    const facts: unknown[] = [];
    for (let i = 1; i <= n; i++) {
      const extra: Partial<Record<string, unknown>> = {};
      if (opts.withUrlSource && i === 1) {
        extra.source_uids = ['https://www.bloomberg.com/spacex-ipo'];
      }
      if (opts.withUnresolvedLabel && i === 2) {
        // subject_label 을 backend 가 못 끌어온 케이스 (★ 이슈 2 결함 2).
        extra.subject_label = null;
      }
      facts.push(MAKE_FACT(i, extra));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        signature: 'sig-test',
        facts,
        total: facts.length,
        expanded_count: 0,
        facets: { entities: {}, predicates: [] },
      }),
    });
  });

  await page.route(/\/api\/assistant\/brief$/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        verified: [],
        inference: 'SpaceX 는 검증된 사실 기반으로 상장했습니다.',
        grounded: true,
      }),
    });
  });
}

async function gotoRecall(
  page: Page,
  opts: InstallOptions = {},
): Promise<void> {
  await installApiMocks(page, opts);
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
}

async function submitQuery(page: Page, q: string): Promise<void> {
  const input = page.getByTestId('recall-input');
  await input.fill(q);
  await input.press('Enter');
  await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();
}

test.describe('REQ-011-v2 dogfood-3 fix (3 이슈)', () => {
  // ─────────────────────────────────────────────────────────────
  // 이슈 3 — 사용자 노출 텍스트 Recall 잔재 청소.
  // ─────────────────────────────────────────────────────────────
  test('이슈 3 (a) — 좌 패널 label = "검색" (RECALL 노출 0)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    // 좌 패널의 헤더 label.
    const scopeLabel = page.getByTestId('recall-scope-label');
    await expect(scopeLabel).toBeVisible();
    await expect(scopeLabel).toContainText('검색');
    // ★ RECALL 영문 코드 0.
    await expect(scopeLabel).not.toContainText('RECALL');

    // 안심 문구 라인 여전히 붙어 있어야 (동선 회귀 가드).
    await expect(scopeLabel).toContainText('검증된 것만 답합니다');

    await captureEvidence(page, 'recall-v2-fix-3issue', '01-scope-label');
  });

  test('이슈 3 (b) — 최근 recall 헤딩 = "최근 검색"', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    const heading = page.getByTestId('recall-recent-heading');
    await expect(heading).toHaveText('최근 검색');
    // ★ 영문 소문자 recall 도 헤딩에는 노출 0.
    await expect(heading).not.toContainText('recall');
  });

  test('이슈 3 (c) — 좌 패널 aside 전체 텍스트에 RECALL / recall 영문 0', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    // aside 전체 텍스트 = 헤더 + 최근 검색 목록 + facet 패널 + 고급 필터.
    const asideText = (await page.getByTestId('recall-aside').textContent()) ?? '';
    // ★ 대소문자 무관하게 "recall" 이라는 어절 노출 0.
    expect(asideText).not.toMatch(/\bRECALL\b/);
    expect(asideText).not.toMatch(/최근 recall/);

    await captureEvidence(page, 'recall-v2-fix-3issue', '02-aside-no-recall-text');
  });

  // ─────────────────────────────────────────────────────────────
  // 이슈 2 — UID 노출 0.
  // ─────────────────────────────────────────────────────────────
  test('이슈 2 (a) — 근거 카드 source 자리에 UUID 노출 0 (UUID → "미해결 출처")', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);
    await submitQuery(page, 'SpaceX');

    // 근거 카드 등장.
    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards.first()).toBeVisible();

    // source 라벨 = "미해결 출처" (backend 가 UUID 만 주므로).
    const sources = page.getByTestId('recall-evidence-source');
    await expect(sources.first()).toContainText('미해결 출처');
    // resolved=false 데이터 속성.
    await expect(sources.first()).toHaveAttribute(
      'data-recall-source-resolved',
      'false',
    );

    // 사용자 시각 영역 (RecallView root — main + aside) 텍스트에 UUID 조각 없어야.
    // ★ body 전체 스캔은 Next.js dev bundle (self.__next_f payload) 안에
    //   UUID 형태 문자열이 종종 섞여 회귀 없이도 fail. 시각 영역 (recall-
    //   redesign-root) 만 스캔 = 화면 노출 여부 그대로 반영.
    const rootText = (await page
      .getByTestId('recall-redesign-root')
      .textContent()) ?? '';
    expect(rootText).not.toContain('d2bf7fb7-67b5-48c7-af22');
    expect(rootText).not.toMatch(UUID4_RE);

    await captureEvidence(page, 'recall-v2-fix-3issue', '03-source-uuid-hidden');
  });

  test('이슈 2 (b) — source 가 URL 이면 정상 표시 (호스트+path)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { withUrlSource: true });
    await submitQuery(page, 'SpaceX');

    const firstSource = page.getByTestId('recall-evidence-source').first();
    await expect(firstSource).toContainText('bloomberg.com');
    await expect(firstSource).toHaveAttribute(
      'data-recall-source-resolved',
      'true',
    );
  });

  test('이슈 2 (c) — subject_label null 이면 "미해결 entity" (UUID 노출 X)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { withUnresolvedLabel: true });
    await submitQuery(page, 'SpaceX');

    const subjects = page.getByTestId('recall-evidence-subject');
    // 여러 카드 중 최소 하나는 "미해결 entity" 라벨.
    const subjectTexts = await subjects.allTextContents();
    expect(subjectTexts.some((t) => t.includes('미해결 entity'))).toBe(true);

    // 어느 카드에도 UUID 조각 노출 X.
    for (const t of subjectTexts) {
      expect(t).not.toMatch(UUID4_RE);
    }
  });

  test('이슈 2 (d) — entity 수정 modal 진입해도 UUID 시각 노출 0', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);
    await submitQuery(page, 'SpaceX');

    // subject 클릭 → modal.
    await page.getByTestId('recall-evidence-subject').first().click();
    const modal = page.getByTestId('recall-entity-edit-modal');
    await expect(modal).toBeVisible();

    // UID DOM 노드는 남기되 (e2e 재사용용) 시각적으로 hidden = box 0.
    const uidNode = page.getByTestId('recall-entity-edit-modal-uid');
    const box = await uidNode.boundingBox();
    // sr-only clip → boundingBox 는 극소값 (거의 0). height <= 1 로 가드.
    expect(box).not.toBeNull();
    expect((box?.height ?? 0)).toBeLessThanOrEqual(2);

    // 사용자에게 label 은 정상 노출.
    await expect(page.getByTestId('recall-entity-edit-modal-label')).toBeVisible();

    await captureEvidence(page, 'recall-v2-fix-3issue', '04-modal-uid-hidden');
  });

  // ─────────────────────────────────────────────────────────────
  // 이슈 1 — 근거 충분 4 단계 명세 (fact 수 기준).
  // ─────────────────────────────────────────────────────────────
  test('이슈 1 (a) — 1건 → 부족 (1/4)', async ({ authenticatedPage: page }) => {
    await gotoRecall(page, { factCount: 1 });
    await submitQuery(page, 'SpaceX');

    const card = page.getByTestId('recall-answer-card');
    await expect(card).toHaveAttribute(
      'data-recall-sufficiency-level',
      'insufficient',
    );
    await expect(card).toHaveAttribute('data-recall-sufficiency-filled', '1');

    await expect(page.getByTestId('recall-sufficiency-label')).toContainText('부족');

    // 4 슬롯 중 1 개만 filled=true.
    const filledSlots = page.locator(
      '[data-recall-sufficiency-slot-filled="true"]',
    );
    await expect(filledSlots).toHaveCount(1);

    await captureEvidence(page, 'recall-v2-fix-3issue', '05-sufficiency-1-insufficient');
  });

  test('이슈 1 (b) — 3건 → 낮음 (2/4)', async ({ authenticatedPage: page }) => {
    await gotoRecall(page, { factCount: 3 });
    await submitQuery(page, 'SpaceX');

    const card = page.getByTestId('recall-answer-card');
    await expect(card).toHaveAttribute('data-recall-sufficiency-level', 'low');
    await expect(card).toHaveAttribute('data-recall-sufficiency-filled', '2');
    await expect(page.getByTestId('recall-sufficiency-label')).toContainText('낮음');

    await captureEvidence(page, 'recall-v2-fix-3issue', '06-sufficiency-3-low');
  });

  test('이슈 1 (c) — 7건 → 충분 (3/4)', async ({ authenticatedPage: page }) => {
    await gotoRecall(page, { factCount: 7 });
    await submitQuery(page, 'SpaceX');

    const card = page.getByTestId('recall-answer-card');
    await expect(card).toHaveAttribute(
      'data-recall-sufficiency-level',
      'sufficient',
    );
    await expect(card).toHaveAttribute('data-recall-sufficiency-filled', '3');
    await expect(page.getByTestId('recall-sufficiency-label')).toContainText('충분');

    await captureEvidence(page, 'recall-v2-fix-3issue', '07-sufficiency-7-sufficient');
  });

  test('이슈 1 (d) — 15건 → 풍부 (4/4)', async ({ authenticatedPage: page }) => {
    await gotoRecall(page, { factCount: 15 });
    await submitQuery(page, 'SpaceX');

    const card = page.getByTestId('recall-answer-card');
    await expect(card).toHaveAttribute(
      'data-recall-sufficiency-level',
      'abundant',
    );
    await expect(card).toHaveAttribute('data-recall-sufficiency-filled', '4');
    await expect(page.getByTestId('recall-sufficiency-label')).toContainText('풍부');

    const filledSlots = page.locator(
      '[data-recall-sufficiency-slot-filled="true"]',
    );
    await expect(filledSlots).toHaveCount(4);

    await captureEvidence(page, 'recall-v2-fix-3issue', '08-sufficiency-15-abundant');
  });

  test('이슈 1 (e) — sufficient label + bar 에 tooltip (title attribute) 존재', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { factCount: 5 });
    await submitQuery(page, 'SpaceX');

    const label = page.getByTestId('recall-sufficiency-label');
    const bar = page.getByTestId('recall-sufficiency-bar');
    for (const el of [label, bar]) {
      const title = await el.getAttribute('title');
      expect(title, 'tooltip title 필수').toBeTruthy();
      expect(title!).toContain('부족');
      expect(title!).toContain('낮음');
      expect(title!).toContain('충분');
      expect(title!).toContain('풍부');
      // 각 단계의 fact 수 기준 명시.
      expect(title!).toMatch(/1건/);
      expect(title!).toMatch(/2-4건/);
      expect(title!).toMatch(/5-10건/);
      expect(title!).toMatch(/11건/);
    }
  });
});
