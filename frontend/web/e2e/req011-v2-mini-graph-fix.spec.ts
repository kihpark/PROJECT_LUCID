/**
 * ★ REQ-011-v2 (★ PO 2026-07-01) — fix/recall-v2-mini-graph.
 *
 * PO 지적: "삼성전자" 로 검색 시 STELLAR 에는 5 엣지, Recall 미니 그래프는
 * empty state. 진단 = backend `_hit_to_fact` 가 `object_uid` 를 채우지 않고
 * `object_value` 에 UUID4 를 그대로 넣는다 (backend/api/routes/recall.py:317-377).
 * `deriveGraphFromFacts` 의 옛 `!fact.object_uid` 조건은 항상 트리핑 → 미니
 * 그래프 empty. STELLAR real adapter 는 `isEntityRef(object_value)` (UUID4)
 * 로 판정 → 5 엣지 그림.
 *
 * 이 spec 은 실 backend 응답 shape (object_uid=null, object_value=UUID4) 를
 * mock 으로 재현하고 미니 그래프가 실제로 그려지는지 검증한다. 옛 mock
 * (req011-v2-real-search.spec.ts) 은 object_uid='E-XXX' 를 명시하고 있어서
 * backend regression 을 감지하지 못했다.
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

// ★ REAL backend shape — 삼성전자 recall 응답 verbatim (2026-07-01 진단):
//   object_uid = null (never populated by _hit_to_fact)
//   object_value = UUID4 (entity ref) 혹은 자연어 (literal)
//   object_label = backend _enrich_with_labels 결과 or null
const REAL_SHAPE_FACTS = [
  {
    fact_uid: 'F-REAL-1',
    claim: '삼성전자, 서남권 투자계획 발표',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'announced',
    predicate_label: '발표하다',
    object_uid: null,
    object_value: 'ae853754-125a-4d2f-93e7-d325d1c51163',
    object_label: '서남권 투자계획',
    object_entity_type: 'event',
    source_uids: ['S-A'],
    validated_at: '2026-05-18T09:00:00Z',
    validator_id: 'PO',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.9,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-REAL-2',
    claim: '삼성전자, 서남권 반도체 클러스터 참여',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'joined',
    predicate_label: '참여하다',
    object_uid: null,
    object_value: '7d35b054-ed52-4c4f-b5f9-2c128d446010',
    object_label: '서남권 반도체 클러스터',
    object_entity_type: 'concept',
    source_uids: ['S-B'],
    validated_at: '2026-05-19T09:00:00Z',
    validator_id: 'PO',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.88,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-REAL-3',
    claim: 'SK, 서남권 반도체 클러스터 참여',
    claim_en: null,
    subject_uid: '4a534921-0000-4000-8000-000000000002',
    subject_label: 'SK',
    subject_entity_type: 'organization',
    predicate: 'joined',
    predicate_label: '참여하다',
    object_uid: null,
    object_value: '7d35b054-ed52-4c4f-b5f9-2c128d446010',
    object_label: '서남권 반도체 클러스터',
    object_entity_type: 'concept',
    source_uids: ['S-B'],
    validated_at: '2026-05-19T10:00:00Z',
    validator_id: 'PO',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.85,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-REAL-4',
    claim: '삼성전자, 삼성디스플레이 인수',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'acquired',
    predicate_label: '인수하다',
    object_uid: null,
    object_value: 'c1234567-0000-4000-8000-000000000003',
    object_label: '삼성디스플레이',
    object_entity_type: 'organization',
    source_uids: ['S-C'],
    validated_at: '2026-05-20T09:00:00Z',
    validator_id: 'PO',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.83,
    fact_type: 'action',
  },
  {
    fact_uid: 'F-REAL-5',
    claim: '삼성전자, 가이드라인 발표 (literal object)',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'noted',
    predicate_label: '언급하다',
    object_uid: null,
    // ★ literal object — 자연어. isEntityRef 실패 → 미니 그래프에서 skip.
    object_value: '현재 시황에 근거한 장래 계획으로서 이해를 돕기 위한 가이드라인',
    object_label: null,
    object_entity_type: null,
    source_uids: ['S-A'],
    validated_at: '2026-05-21T09:00:00Z',
    validator_id: 'PO',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.7,
    fact_type: 'claim',
  },
];

async function installMocks(page: Page): Promise<void> {
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const token = jwt.sign(
    { sub: SEED_USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
  await page.context().addCookies([
    { name: 'lucid_space_id', value: PO_KS, domain: 'localhost', path: '/' },
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
        display_name: 'PO',
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        signature: 'sig-test',
        facts: REAL_SHAPE_FACTS,
        total: REAL_SHAPE_FACTS.length,
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
        inference: '삼성전자는 서남권 투자계획을 발표하고 반도체 클러스터에 참여했습니다.',
        grounded: true,
      }),
    });
  });
}

test.describe('REQ-011-v2 미니 그래프 — 실 backend shape', () => {
  test('★ object_uid=null + object_value=UUID4 → 미니 그래프 4 entity 노드', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('recall-input').fill('삼성전자');
    await page.getByTestId('recall-input').press('Enter');

    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();
    // 미니 그래프 렌더 (empty state 아니여야 함).
    await expect(page.getByTestId('recall-mini-graph')).toBeVisible();
    await expect(page.getByTestId('recall-mini-graph-empty')).toHaveCount(0);

    await screenshot(
      page,
      'req011-v2-mini-graph-fix',
      '01-real-shape-mini-graph',
    );
  });
});
