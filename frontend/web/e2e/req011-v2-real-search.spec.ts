/**
 * ★ REQ-011-v2 (★ PO 2026-07-01) — Recall 실 검색 path e2e.
 *
 * 의뢰서 STEP 2 verbatim:
 *   - 시드: 5+ fact (subject_uid + object_uid 모두 entity)
 *   - 검색 입력 + enter → recall API 호출 → 답변/근거 표시
 *   - 검색 결과 0 → 不知 상태 자동
 *   - onSubjectClick → REQ-012 modal 진입
 *   - screenshot per state
 *
 * v1 의 dogfood 피드백 "검색 자체가 안된다" 해소 검증.
 * Backend 의존성 0 — page.route() 로 /api/spaces/.../recall, /api/assistant/brief
 *   mock. 시드는 RecallFact / AssistantBriefResponse shape 그대로.
 */
import { test, expect, PO_KS } from './fixtures/auth';
import type { Page, Route } from '@playwright/test';
import { screenshot } from './helpers/req004Flow';

const SEED_USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// ★ 시드 — 5+ fact, 모두 subject_uid + object_uid 보유 (의뢰서 STEP 2).
//   첫 fact 가 미니 그래프의 center.
const SEEDED_FACTS = [
  {
    fact_uid: 'F-001',
    claim: 'SpaceX 상장 (나스닥)',
    claim_en: null,
    subject_uid: 'E-SPACEX',
    subject_label: 'SpaceX',
    subject_entity_type: 'organization',
    predicate: 'listed_on',
    predicate_label: '상장하다',
    object_uid: 'E-NASDAQ',
    object_label: '나스닥',
    object_value: '나스닥',
    source_uids: ['S-BLOOMBERG'],
    validated_at: '2026-05-18T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.92,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-002',
    claim: 'SpaceX 공모가 $135',
    claim_en: null,
    subject_uid: 'E-SPACEX',
    subject_label: 'SpaceX',
    subject_entity_type: 'organization',
    predicate: 'ipo_price',
    predicate_label: '공모가',
    object_uid: 'E-USD135',
    object_label: '주당 $135',
    object_value: '주당 $135',
    source_uids: ['S-WSJ'],
    validated_at: '2026-05-18T10:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.88,
    fact_type: 'measurement',
  },
  {
    fact_uid: 'F-003',
    claim: 'SpaceX 주관사 = 골드만삭스',
    claim_en: null,
    subject_uid: 'E-SPACEX',
    subject_label: 'SpaceX',
    subject_entity_type: 'organization',
    predicate: 'underwriter',
    predicate_label: '주관사',
    object_uid: 'E-GOLDMAN',
    object_label: '골드만삭스',
    object_value: '골드만삭스',
    source_uids: ['S-REUTERS'],
    validated_at: '2026-05-20T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.85,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-004',
    claim: 'SpaceX 본사 위치 = 호손',
    claim_en: null,
    subject_uid: 'E-SPACEX',
    subject_label: 'SpaceX',
    subject_entity_type: 'organization',
    predicate: 'headquartered_in',
    predicate_label: '본사',
    object_uid: 'E-HAWTHORNE',
    object_label: '호손',
    object_value: '호손',
    source_uids: ['S-BLOOMBERG'],
    validated_at: '2026-05-21T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.82,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-005',
    claim: 'SpaceX 창립자 = Elon Musk',
    claim_en: null,
    subject_uid: 'E-SPACEX',
    subject_label: 'SpaceX',
    subject_entity_type: 'organization',
    predicate: 'founded_by',
    predicate_label: '창립자',
    object_uid: 'E-MUSK',
    object_label: 'Elon Musk',
    object_value: 'Elon Musk',
    source_uids: ['S-WSJ'],
    validated_at: '2026-05-22T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.95,
    fact_type: 'action',
  },
];

interface InstallOptions {
  recallEmpty?: boolean;
  withBrief?: boolean;
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

  // catchall — 가장 먼저 등록. specific 들이 뒤에서 덮는다.
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

  // recall API — empty mode = 0 hits, default = 5 fact 시드.
  await page.route(/\/api\/spaces\/[^/]+\/recall\?.*/, async (route: Route) => {
    const facts = opts.recallEmpty ? [] : SEEDED_FACTS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        signature: 'sig-test',
        facts,
        total: facts.length,
        expanded_count: 0,
        facets: {
          entities: {},
          predicates: [],
        },
      }),
    });
  });

  // HEARTH endpoint — answer 합성.
  await page.route(/\/api\/assistant\/brief$/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        verified: [],
        inference:
          '당신이 검증한 사실에 따르면, SpaceX는 2026년 나스닥에 상장했으며 공모가는 주당 $135였습니다. 주관사는 골드만삭스이고 본사는 호손에 위치합니다.',
        grounded: true,
      }),
    });
  });

  // REQ-012 — entity type change endpoint (modal 진입 후 저장 path).
  await page.route(
    /\/api\/spaces\/[^/]+\/entities\/[^/]+\/type$/,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          entity_uid: 'E-SPACEX',
          primary_label: 'SpaceX',
          previous_entity_type: 'organization',
          entity_type: 'organization',
          relabel_history_size: 1,
          updated_at: new Date().toISOString(),
        }),
      });
    },
  );

  // REQ-012 — merge-candidates (모달 안에서 호출되지만 본 spec 에서는 진입까지만).
  await page.route(
    /\/api\/spaces\/[^/]+\/entities\/[^/]+\/merge-candidates(\?.*)?$/,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({ items: [] }),
      });
    },
  );
}

async function gotoRecall(page: Page, opts: InstallOptions = {}): Promise<void> {
  await installApiMocks(page, opts);
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
}

test.describe('REQ-011-v2 Recall 실 검색 path', () => {
  test('★ 검색 입력 + enter → recall API → 답변 카드 + 근거 + 미니 그래프', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    // 첫 진입 = v1 예시 (q1 SpaceX) — 옛 동선 보존.
    await expect(page.getByTestId('recall-known-panel')).toBeVisible();

    // 검색 — input 에 query + enter.
    const input = page.getByTestId('recall-input');
    await input.fill('SpaceX 상장에 대해');
    await input.press('Enter');

    // 실데이터 known 패널 등장 + 예시 패널 사라짐.
    const realPanel = page.getByTestId('recall-real-known-panel');
    await expect(realPanel).toBeVisible();
    await expect(page.getByTestId('recall-known-panel')).toBeHidden();

    // 카운트 (5 fact + 3 unique source : Bloomberg, WSJ, Reuters).
    await expect(realPanel).toHaveAttribute('data-recall-fact-count', '5');
    await expect(realPanel).toHaveAttribute('data-recall-source-count', '3');

    // 답변 카드 = HEARTH inference 텍스트.
    await expect(page.getByTestId('recall-answer-text')).toContainText('나스닥');
    // 실데이터 모드 = '예시' 마커 OFF.
    await expect(page.getByTestId('recall-answer-card')).toHaveAttribute(
      'data-recall-answer-example',
      'false',
    );

    // 근거 카드 5장 (real 모드).
    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards).toHaveCount(5);
    await expect(cards.first()).toHaveAttribute(
      'data-recall-evidence-mode',
      'real',
    );

    // 미니 그래프 (5 entity-entity edges).
    await expect(page.getByTestId('recall-mini-graph')).toBeVisible();

    await screenshot(
      page,
      'req011-v2-real-search',
      '01-real-known-panel',
    );
  });

  test('★ 검색 결과 0 → 不知 상태 자동', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { recallEmpty: true });

    const input = page.getByTestId('recall-input');
    await input.fill('테슬라 4분기 실적');
    await input.press('Enter');

    // 不知 자동 (recall hits 0).
    await expect(page.getByTestId('recall-unknown-state')).toBeVisible();
    await expect(page.getByTestId('recall-unknown-question')).toContainText(
      '테슬라 4분기 실적',
    );
    // 실데이터 known 패널은 표시되지 않음.
    await expect(page.getByTestId('recall-real-known-panel')).toBeHidden();
    // HEARTH 도 호출되지 않음 (answer 자리 — RecallAnswerCard 없어야 함).
    await expect(page.getByTestId('recall-answer-card')).toBeHidden();

    await screenshot(
      page,
      'req011-v2-real-search',
      '02-real-unknown-state',
    );
  });

  test('★ 예시 배너 자동 OFF — 실데이터 path 동작 시', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    // 첫 진입 = 예시 배너 ON.
    await expect(page.getByTestId('recall-example-banner')).toBeVisible();

    // 검색 후 = 예시 패널 사라짐 → 예시 배너도 사라짐.
    await page.getByTestId('recall-input').fill('SpaceX');
    await page.getByTestId('recall-input').press('Enter');
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();
    await expect(page.getByTestId('recall-example-banner')).toBeHidden();
  });

  test('★ onSubjectClick → REQ-012 entity 수정 modal 진입', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    await page.getByTestId('recall-input').fill('SpaceX');
    await page.getByTestId('recall-input').press('Enter');

    // 실데이터 카드 등장.
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();

    // 첫 카드 의 subject (SpaceX) 클릭.
    const firstSubject = page.getByTestId('recall-evidence-subject').first();
    await firstSubject.click();

    // REQ-012 entity 수정 modal 진입.
    const modal = page.getByTestId('recall-entity-edit-modal');
    await expect(modal).toBeVisible();
    await expect(
      page.getByTestId('recall-entity-edit-modal-label'),
    ).toHaveText('SpaceX');
    await expect(
      page.getByTestId('recall-entity-edit-modal-uid'),
    ).toHaveText('E-SPACEX');

    // EntityTypeDropdown + merge open 버튼 두 자리 모두 존재 (★ REQ-012 entry).
    await expect(page.getByTestId('entity-type-dropdown')).toBeVisible();
    await expect(
      page.getByTestId('recall-entity-edit-modal-merge-open'),
    ).toBeVisible();

    await screenshot(
      page,
      'req011-v2-real-search',
      '03-entity-edit-modal',
    );

    // 닫기 → modal 사라짐.
    await page.getByTestId('recall-entity-edit-modal-close').click();
    await expect(modal).toBeHidden();
  });

  test('★ 빈 query 는 검색 호출 X — 옛 예시 패널 그대로', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page);

    // 빈 input + enter — 변화 없어야 함.
    await page.getByTestId('recall-input').press('Enter');
    await expect(page.getByTestId('recall-real-known-panel')).toBeHidden();
    await expect(page.getByTestId('recall-known-panel')).toBeVisible();
  });
});
