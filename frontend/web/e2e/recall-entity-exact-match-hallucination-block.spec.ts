/**
 * ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01) —
 * Recall entity 정확 매칭 + 환각 차단 e2e.
 *
 * PO diagnosis:
 *   - HEARTH 임베딩 유사도로 타 entity fact (더불어민주당) 를 근거로 반환
 *   - LLM 이 "조국혁신당은 더불어민주당과 함께..."로 합성 = 검증 안 된
 *     관계 창작 = 환각
 *
 * Lucid P1: 사용자가 정보 신뢰도 판단. LLM 이 근거 없이 관계를 조합하면
 * 안 됨. 知之為知之.
 *
 * 시나리오:
 *   Seed:
 *     - 조국혁신당: 3 facts (subject_uid = 조국혁신당). match_kind =
 *       'entity_direct' 로 백엔드가 반환.
 *     - 더불어민주당: 3 facts, 조국혁신당 언급 X.
 *   Scenario 1 — Query "조국혁신당" → evidence list 3장, 모두 teal
 *     '직접 언급' 배지, 더불어민주당 fact 미출현.
 *   Scenario 2 — Query "정책 없는 entity" (검증 안 된 entity) →
 *     similarity_fallback path 트리거, 모두 amber '유사 참고' 배지.
 *
 * Backend 의존성 0 — page.route() 로 /api/spaces/.../recall 모킹.
 * 시드는 RecallFact shape 그대로.
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

// ★ 시드 — 조국혁신당 3 facts (전부 subject_uid = 조국혁신당). PO 의뢰서 verbatim.
const JOKUK_FACTS = [
  {
    fact_uid: 'F-JOKUK-001',
    claim: '조국혁신당 창당 발표 (2024-03-03)',
    claim_en: null,
    subject_uid: 'E-JOKUK',
    subject_label: '조국혁신당',
    subject_entity_type: 'organization',
    predicate: 'founded_on',
    predicate_label: '창당',
    object_uid: null,
    object_label: null,
    object_value: '2024-03-03',
    source_uids: ['S-YONHAP'],
    validated_at: '2026-05-18T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.92,
    fact_type: 'action',
    match_kind: 'entity_direct',
  },
  {
    fact_uid: 'F-JOKUK-002',
    claim: '조국혁신당 대표 = 조국',
    claim_en: null,
    subject_uid: 'E-JOKUK',
    subject_label: '조국혁신당',
    subject_entity_type: 'organization',
    predicate: 'led_by',
    predicate_label: '대표',
    object_uid: 'E-CHOKUK',
    object_label: '조국',
    object_value: 'E-CHOKUK',
    source_uids: ['S-KBS'],
    validated_at: '2026-05-20T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.9,
    fact_type: 'action',
    match_kind: 'entity_direct',
  },
  {
    fact_uid: 'F-JOKUK-003',
    claim: '조국혁신당 22대 총선 12석 획득',
    claim_en: null,
    subject_uid: 'E-JOKUK',
    subject_label: '조국혁신당',
    subject_entity_type: 'organization',
    predicate: 'seats_won',
    predicate_label: '의석수',
    object_uid: null,
    object_label: null,
    object_value: '12',
    source_uids: ['S-JTBC'],
    validated_at: '2026-05-22T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.88,
    fact_type: 'measurement',
    metric: '의석수',
    measurement_value: 12,
    measurement_unit: '석',
    as_of: '2024-04-10',
    match_kind: 'entity_direct',
  },
];

// ★ 시드 — 더불어민주당 3 facts. 조국혁신당 언급 없음. 시나리오 1 에서
// 절대 recall 결과에 나오면 안 되는 반례.
const DEMOCRATIC_FACTS = [
  {
    fact_uid: 'F-DEMO-001',
    claim: '더불어민주당 대표 = 이재명',
    claim_en: null,
    subject_uid: 'E-DEMOCRATIC',
    subject_label: '더불어민주당',
    subject_entity_type: 'organization',
    predicate: 'led_by',
    predicate_label: '대표',
    object_uid: 'E-LEEJM',
    object_label: '이재명',
    object_value: 'E-LEEJM',
    source_uids: ['S-YONHAP'],
    validated_at: '2026-05-19T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.7,
    fact_type: 'action',
    match_kind: 'similarity_fallback',
  },
  {
    fact_uid: 'F-DEMO-002',
    claim: '더불어민주당 22대 총선 175석 획득',
    claim_en: null,
    subject_uid: 'E-DEMOCRATIC',
    subject_label: '더불어민주당',
    subject_entity_type: 'organization',
    predicate: 'seats_won',
    predicate_label: '의석수',
    object_uid: null,
    object_label: null,
    object_value: '175',
    source_uids: ['S-JTBC'],
    validated_at: '2026-05-21T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.68,
    fact_type: 'measurement',
    metric: '의석수',
    measurement_value: 175,
    measurement_unit: '석',
    as_of: '2024-04-10',
    match_kind: 'similarity_fallback',
  },
  {
    fact_uid: 'F-DEMO-003',
    claim: '더불어민주당 정책위의장 = 진성준',
    claim_en: null,
    subject_uid: 'E-DEMOCRATIC',
    subject_label: '더불어민주당',
    subject_entity_type: 'organization',
    predicate: 'policy_chair',
    predicate_label: '정책위의장',
    object_uid: 'E-JINSJ',
    object_label: '진성준',
    object_value: 'E-JINSJ',
    source_uids: ['S-KBS'],
    validated_at: '2026-05-23T09:00:00Z',
    validator_id: '박기흥',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.65,
    fact_type: 'action',
    match_kind: 'similarity_fallback',
  },
];

interface InstallOptions {
  mode: 'entity_direct_jokuk' | 'similarity_fallback';
}

async function installApiMocks(
  page: Page,
  opts: InstallOptions,
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
        totals: { facts: 6, entities: 3, sources: 3, this_week_validated: 6 },
        pending_validation: 0,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
  });

  // ★ recall API — 백엔드 strict entity match 시뮬레이션.
  //   entity_direct_jokuk: 조국혁신당 시드 3장만 반환 (더불어민주당 fact
  //     절대 미포함 — hallucination 방지의 핵심).
  //   similarity_fallback: 조국혁신당 매칭 없이 similarity_fallback 태그로
  //     더불어민주당 3장 반환.
  await page.route(/\/api\/spaces\/[^/]+\/recall\?.*/, async (route: Route) => {
    const facts =
      opts.mode === 'entity_direct_jokuk' ? JOKUK_FACTS : DEMOCRATIC_FACTS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        signature: `As far as I know — 그래프에 ${facts.length}개 검증 사실이 있습니다`,
        facts,
        total: facts.length,
        expanded_count: 0,
        facets: { entities: {}, predicates: [] },
      }),
    });
  });

  // HEARTH mock — inference 는 근거 fact 만 요약. 환각 방지 시연.
  await page.route(/\/api\/assistant\/brief$/, async (route: Route) => {
    const inference =
      opts.mode === 'entity_direct_jokuk'
        ? '검증된 사실에 따르면, 조국혁신당은 2024-03-03 창당했고 대표는 조국이며 22대 총선에서 12석을 획득했습니다.'
        : '이 질문에 대한 검증된 사실이 부족합니다.';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        verified: [],
        inference,
        grounded: opts.mode === 'entity_direct_jokuk',
      }),
    });
  });
}

async function gotoRecall(
  page: Page,
  opts: InstallOptions,
): Promise<void> {
  await installApiMocks(page, opts);
  await page.goto('/recall');
  await page.waitForLoadState('networkidle');
}

test.describe('★ fix/recall-entity-exact-match-hallucination-block', () => {
  test('★ 조국혁신당 검색 → 3 facts + 직접 언급 teal badge + 더불어민주당 fact 미포함', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { mode: 'entity_direct_jokuk' });

    await expect(page.getByTestId('recall-known-panel')).toBeVisible();

    await page.getByTestId('recall-input').fill('조국혁신당');
    await page.getByTestId('recall-input').press('Enter');

    // 실데이터 known 패널 등장.
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();

    // ★ 조국혁신당 fact 정확히 3장.
    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards).toHaveCount(3);

    // ★ REQ-014-E (PO 2026-07-02) — match_kind 배지 자체 폐기.
    //   백엔드가 entity_direct 로 판정한 사실만 나오는지의 hallucination-block
    //   자체는 아래 "더불어민주당 fact 노출 안 됨" 라인으로 계속 검증한다.
    await expect(
      page.getByTestId('recall-evidence-match-kind'),
    ).toHaveCount(0);

    // ★ 더불어민주당 fact 절대 노출 안 됨 (hallucination 방지 핵심).
    for (const demoFact of ['F-DEMO-001', 'F-DEMO-002', 'F-DEMO-003']) {
      await expect(page.locator(`text=${demoFact}`)).toHaveCount(0);
    }
    // 조국혁신당 fact 노출 확인.
    await expect(cards.first()).toContainText('조국혁신당');
    await expect(cards.nth(1)).toContainText('조국혁신당');
    await expect(cards.nth(2)).toContainText('조국혁신당');
    // '더불어민주당' 단어가 카드 어디에도 없어야 함.
    await expect(page.getByTestId('recall-real-known-panel')).not.toContainText(
      '더불어민주당',
    );
    // HEARTH inference 도 검증 fact 만 반영.
    await expect(page.getByTestId('recall-answer-text')).toContainText('조국혁신당');
    await expect(page.getByTestId('recall-answer-text')).not.toContainText(
      '더불어민주당',
    );

    await screenshot(
      page,
      'recall-entity-exact-match-hallucination-block',
      '01-entity-direct-jokuk',
    );
  });

  test('★ Query 매칭 entity 0 → similarity fallback (배지 없음, 사실만 노출)', async ({
    authenticatedPage: page,
  }) => {
    await gotoRecall(page, { mode: 'similarity_fallback' });

    await page.getByTestId('recall-input').fill('정당 대표');
    await page.getByTestId('recall-input').press('Enter');

    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();

    const cards = page.getByTestId('recall-evidence-card');
    await expect(cards).toHaveCount(3);

    // ★ REQ-014-E (PO 2026-07-02) — "유사 참고" 배지 자체 폐기.
    //   사용자 클릭 유도 없는 노이즈였음. similarity_fallback 경로 자체는
    //   backend 가 hits 를 실어 보내는지로 계속 검증 (cards.toHaveCount(3)).
    await expect(
      page.getByTestId('recall-evidence-match-kind'),
    ).toHaveCount(0);

    await screenshot(
      page,
      'recall-entity-exact-match-hallucination-block',
      '02-similarity-fallback',
    );
  });
});
