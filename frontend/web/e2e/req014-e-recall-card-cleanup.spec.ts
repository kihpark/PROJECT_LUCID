/**
 * ★ REQ-014-E (PO 2026-07-02) — 근거 사실 카드 정리 3 이슈.
 *
 * PO dogfood image #151 verbatim:
 *   이슈 1: 각 근거 카드 하단 "미해결 출처" 옆에 UUID (validator_id) 노출.
 *     → backend `_hit_to_fact` 이 user_id (UUID) 를 그대로 실어 보내며,
 *       옛 카드는 meta 라인 마지막 span 에 그대로 렌더. STAGE 3+4 원칙
 *       (UUID 사용자 노출 0) 회귀.
 *
 *   이슈 2: match_kind !== 'entity_direct' → "유사 참고" amber 배지.
 *     → PO: "클릭도 안 되는데 왜? 사용자 무가치". 배지 자체 폐기.
 *
 *   이슈 3: 카드 hover 시 cursor: pointer, 클릭해도 아무 동작 X.
 *     → wrapper cursor 를 default 로 되돌리고 hover 강조도 제거. subject
 *       (대상) 링크만 클릭 (기존 handleSubjectClick 유지).
 *
 * 원칙 (PO): "목적 없는 UI 금지".
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

// UUID4 (하이픈 포함) — 화면 텍스트에 등장하면 회귀.
const UUID4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

// ★ image #151 재현 시드: validator_id 를 UUID (실 backend 형식) 로.
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
  source_uids: ['d2bf7fb7-67b5-48c7-af22-1234567890ab'],
  validated_at: '2026-06-24T09:00:00Z',
  // ★ 이슈 1 재현 — validator_id 가 UUID (실 backend 는 user_id).
  validator_id: SEED_USER_ID,
  validation_method: 'manual',
  knowledge_space_id: PO_KS,
  negation_flag: false,
  negation_scope: null,
  score: 0.9,
  // ★ 이슈 2 재현 — 옛 UI 는 이 값으로 "유사 참고" amber 배지 노출.
  match_kind: 'similarity_fallback' as const,
  fact_type: 'action',
  ...extra,
});

interface InstallOptions {
  factCount?: number;
  humanValidator?: string; // 사람 이름으로 override (예: '박기흥').
  directMatch?: boolean;   // match_kind = 'entity_direct'.
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
    const n = opts.factCount ?? 3;
    const facts: unknown[] = [];
    for (let i = 1; i <= n; i++) {
      const extra: Partial<Record<string, unknown>> = {};
      if (opts.humanValidator) extra.validator_id = opts.humanValidator;
      if (opts.directMatch) extra.match_kind = 'entity_direct';
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

test.describe('REQ-014-E — 근거 사실 카드 정리 3 이슈', () => {
  // ─────────────────────────────────────────────────────────────
  // 이슈 1 — validator_id UUID 노출 0.
  // ─────────────────────────────────────────────────────────────
  test('이슈 1 (a) — validator_id = UUID → meta 라인에 UUID 조각 0', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);
    await submitQuery(page, 'SpaceX');

    // 근거 카드 등장.
    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards.first()).toBeVisible();

    // ★ 시각 영역 (recall-redesign-root) 텍스트에 UUID 조각 없어야.
    const rootText = (await page
      .getByTestId('recall-redesign-root')
      .textContent()) ?? '';
    expect(rootText).not.toContain(SEED_USER_ID);
    expect(rootText).not.toMatch(UUID4_RE);

    // ★ "미해결 출처" 는 여전히 렌더 (source_uid 가 UUID 이므로).
    const source = page.getByTestId('recall-evidence-source').first();
    await expect(source).toContainText('미해결 출처');

    await captureEvidence(
      page,
      'req014-e-recall-card-cleanup',
      '01-validator-uuid-hidden',
    );
  });

  test('이슈 1 (b) — validator_id 가 사람 이름 ("박기흥") 이면 그대로 표시', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { humanValidator: '박기흥' });
    await submitQuery(page, 'SpaceX');

    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards.first()).toBeVisible();

    // 사람 이름은 meta 라인 마지막 span 에 정상 노출.
    const rootText = (await page
      .getByTestId('recall-redesign-root')
      .textContent()) ?? '';
    expect(rootText).toContain('박기흥');
    // ★ 여전히 UUID 조각은 노출 0.
    expect(rootText).not.toMatch(UUID4_RE);

    await captureEvidence(
      page,
      'req014-e-recall-card-cleanup',
      '02-validator-human-name-visible',
    );
  });

  // ─────────────────────────────────────────────────────────────
  // 이슈 2 — match_kind 배지 폐기.
  // ─────────────────────────────────────────────────────────────
  test('이슈 2 (a) — similarity_fallback 카드에도 "유사 참고" 배지 없음', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);
    await submitQuery(page, 'SpaceX');

    await expect(
      page.getByTestId('recall-evidence-card').first(),
    ).toBeVisible();

    // ★ 배지 자체가 DOM 에서 사라져야.
    await expect(page.getByTestId('recall-evidence-match-kind')).toHaveCount(0);

    // ★ 시각 영역에 "유사 참고" text 없어야.
    const rootText = (await page
      .getByTestId('recall-redesign-root')
      .textContent()) ?? '';
    expect(rootText).not.toContain('유사 참고');

    await captureEvidence(
      page,
      'req014-e-recall-card-cleanup',
      '03-similarity-badge-removed',
    );
  });

  test('이슈 2 (b) — entity_direct 카드에도 "직접 언급" 배지 없음', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { directMatch: true });
    await submitQuery(page, 'SpaceX');

    await expect(
      page.getByTestId('recall-evidence-card').first(),
    ).toBeVisible();

    await expect(page.getByTestId('recall-evidence-match-kind')).toHaveCount(0);

    const rootText = (await page
      .getByTestId('recall-redesign-root')
      .textContent()) ?? '';
    expect(rootText).not.toContain('직접 언급');
  });

  // ─────────────────────────────────────────────────────────────
  // 이슈 3 — 카드 wrapper cursor default.
  // ─────────────────────────────────────────────────────────────
  test('이슈 3 (a) — 카드 wrapper cursor = default', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);
    await submitQuery(page, 'SpaceX');

    const card = page.getByTestId('recall-evidence-card').first();
    await expect(card).toBeVisible();

    const cursor = await card.evaluate(
      (el) => window.getComputedStyle(el).cursor,
    );
    expect(cursor).toBe('default');

    await captureEvidence(
      page,
      'req014-e-recall-card-cleanup',
      '04-card-cursor-default',
    );
  });

  test('이슈 3 (b) — subject (대상) 링크는 여전히 cursor pointer + 클릭 가능', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);
    await submitQuery(page, 'SpaceX');

    const subject = page.getByTestId('recall-evidence-subject').first();
    await expect(subject).toBeVisible();

    const cursor = await subject.evaluate(
      (el) => window.getComputedStyle(el).cursor,
    );
    expect(cursor).toBe('pointer');

    // 클릭 → entity edit modal 진입 (REQ-012 회귀 가드).
    await subject.click();
    await expect(page.getByTestId('recall-entity-edit-modal')).toBeVisible();

    await captureEvidence(
      page,
      'req014-e-recall-card-cleanup',
      '05-subject-still-clickable',
    );
  });
});
