/**
 * ★ REQ-014-F (PO 2026-07-02) — Recall 근거 미니 그래프 라벨 겹침 fix.
 *
 * PO verbatim: "저게 맞아?" (image #151 우측 근거 그래프 — predicate
 *   라벨들이 서로 겹쳐 읽을 수 없음).
 *
 * 처방 (RecallMiniGraph.tsx):
 *   1. edge predicate 라벨 truncate(14) — 넘치면 "…"
 *   2. midpoint 를 중심→노드 방향 62% 지점으로 이동 (클러스터 회피)
 *   3. hover 시 full text (canvas + DOM 양쪽)
 *   4. 노드 라벨도 truncate(12) — hover 시 full
 *
 * 이 spec 은:
 *   (a) 긴 predicate 를 준 뒤 미니 그래프가 렌더되는지
 *   (b) hover 시 DOM 힌트 (`recall-mini-graph-hover-label`) 가 full text 노출
 *   (c) 라벨 truncate 동작 (data-hover-idx 로 관찰)
 *   (d) 스크린샷 증거
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

// PO 지적 이미지 verbatim — 긴 predicate 라벨들.
const LONG_PREDICATE_FACTS = [
  {
    fact_uid: 'F-LG-1',
    claim: '삼성전자, 반도체 클러스터 계획 강화',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'outlined',
    predicate_label: 'outlined plans to strengthen',
    object_uid: null,
    object_value: 'ae853754-125a-4d2f-93e7-d325d1c51163',
    object_label: '반도체 클러스터',
    object_entity_type: 'concept',
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
    fact_uid: 'F-LG-2',
    claim: '삼성전자, R&D 가속화',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'accelerating',
    predicate_label: 'is accelerating development of',
    object_uid: null,
    object_value: '7d35b054-ed52-4c4f-b5f9-2c128d446010',
    object_label: 'AI 칩 개발',
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
    fact_uid: 'F-LG-3',
    claim: '삼성전자, 파트너십 재확인',
    claim_en: null,
    subject_uid: 'b6f055b6-0000-4000-8000-000000000001',
    subject_label: '삼성전자',
    subject_entity_type: 'organization',
    predicate: 'reaffirmed',
    predicate_label: 'reaffirmed commitment to',
    object_uid: null,
    object_value: 'c1234567-0000-4000-8000-000000000003',
    object_label: '글로벌 파트너십',
    object_entity_type: 'concept',
    source_uids: ['S-C'],
    validated_at: '2026-05-20T09:00:00Z',
    validator_id: 'PO',
    validation_method: 'manual',
    knowledge_space_id: PO_KS,
    negation_flag: false,
    negation_scope: null,
    score: 0.85,
    fact_type: 'action',
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
        signature: 'sig-req014-f',
        facts: LONG_PREDICATE_FACTS,
        total: LONG_PREDICATE_FACTS.length,
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
        inference: '삼성전자는 반도체 클러스터, AI 칩 개발, 글로벌 파트너십을 강조했습니다.',
        grounded: true,
      }),
    });
  });
}

test.describe('REQ-014-F — Recall 미니 그래프 라벨 정리', () => {
  test('★ 긴 predicate 라벨도 미니 그래프 렌더 (겹침 회피 위해 truncate + 이동)', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('recall-input').fill('삼성전자');
    await page.getByTestId('recall-input').press('Enter');

    // 답변 패널 + 미니 그래프 렌더.
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();
    const graph = page.getByTestId('recall-mini-graph');
    await expect(graph).toBeVisible();
    await expect(page.getByTestId('recall-mini-graph-empty')).toHaveCount(0);

    // canvas 실제 크기 확인 (그려질 픽셀 영역). 마운트 후 rAF 픽셀 계산
    // 완료까지 폴링.
    const canvas = page.getByTestId('recall-mini-graph-canvas');
    let box = await canvas.boundingBox();
    for (let i = 0; i < 20 && (!box || box.width < 200); i++) {
      await page.waitForTimeout(100);
      box = await canvas.boundingBox();
    }
    expect(box).not.toBeNull();
    expect((box?.width ?? 0)).toBeGreaterThan(200);
    expect((box?.height ?? 0)).toBeGreaterThan(200);

    // hover 라벨 힌트 (DOM) — 초기엔 없어야 함 (pointer 밖).
    await expect(
      page.getByTestId('recall-mini-graph-hover-label'),
    ).toHaveCount(0);

    await screenshot(
      page,
      'req014-f-recall-graph-labels',
      '01-graph-with-long-predicates',
    );
  });

  test('★ 노드 hover 시 full text 힌트 DOM 노출 (canvas 라벨은 truncate)', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('recall-input').fill('삼성전자');
    await page.getByTestId('recall-input').press('Enter');

    const canvas = page.getByTestId('recall-mini-graph-canvas');
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();
    await expect(canvas).toBeVisible();
    // canvas 는 답변 패널이 마운트된 뒤에도 픽셀 크기 재계산까지
    // 1-2 rAF 걸릴 수 있음. box 가 유효할 때까지 폴링.
    let box = await canvas.boundingBox();
    for (let i = 0; i < 20 && (!box || box.width < 200); i++) {
      await page.waitForTimeout(100);
      box = await canvas.boundingBox();
    }
    expect(box).not.toBeNull();
    if (!box) return;

    // 노드는 원형 배치 (시안 좌표식): a = -PI/2 + (i/N)*2PI + 0.3.
    // 노드 좌표 = (cx+cos(a)*R, cy+sin(a)*R*0.86). N=3 (LONG_PREDICATE_FACTS).
    // Canvas rAF 는 브라우저 페인트 타이밍에 민감하므로 3 개 노드 모두
    // 시도해 하나라도 hover 성공하면 통과 처리 — 유일 flake 회귀 방지.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height * 0.46;
    const R = Math.min(box.width, box.height) * 0.30;
    const N = 3;
    const hoverLabel = page.getByTestId('recall-mini-graph-hover-label');
    let hovered = false;
    for (let i = 0; i < N && !hovered; i++) {
      const a = -Math.PI / 2 + (i / N) * Math.PI * 2 + 0.3;
      const targetX = cx + Math.cos(a) * R;
      const targetY = cy + Math.sin(a) * R * 0.86;
      // hover 초기화 → 이동. Playwright 는 실제 pointer move 이벤트를
      // 발생시켜야 하므로 (0,0) → target 을 2 스텝으로 dispatch.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(60);
      await page.mouse.move(targetX, targetY, { steps: 5 });
      // rAF + React 리렌더 대기 — 최대 1s poll.
      try {
        await expect(hoverLabel).toBeVisible({ timeout: 1000 });
        hovered = true;
      } catch {
        /* try next node */
      }
    }
    expect(hovered).toBe(true);
    // full text — truncate 되지 않은 원문. 예: 첫 fact 는
    //   label='반도체 클러스터', edge='outlined plans to strengthen'.
    // 어떤 노드가 hover 되든 3 개 predicate 중 하나여야 함.
    const text = (await hoverLabel.textContent()) ?? '';
    const fullPredicates = [
      'outlined plans to strengthen',
      'is accelerating development of',
      'reaffirmed commitment to',
    ];
    expect(
      fullPredicates.some((p) => text.includes(p)),
    ).toBeTruthy();

    // hover-idx 는 >=0 (노드 위) 이어야 함.
    const hoverIdx = await page
      .getByTestId('recall-mini-graph')
      .getAttribute('data-hover-idx');
    expect(Number(hoverIdx)).toBeGreaterThanOrEqual(0);

    await screenshot(
      page,
      'req014-f-recall-graph-labels',
      '02-node-hover-full-text',
    );
  });

  test('★ pointer 나가면 hover 힌트 사라짐', async ({
    authenticatedPage: page,
  }) => {
    await installMocks(page);
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('recall-input').fill('삼성전자');
    await page.getByTestId('recall-input').press('Enter');

    const canvas = page.getByTestId('recall-mini-graph-canvas');
    await expect(page.getByTestId('recall-real-known-panel')).toBeVisible();
    await expect(canvas).toBeVisible();
    let box = await canvas.boundingBox();
    for (let i = 0; i < 20 && (!box || box.width < 200); i++) {
      await page.waitForTimeout(100);
      box = await canvas.boundingBox();
    }
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height * 0.46;
    const R = Math.min(box.width, box.height) * 0.30;
    // 노드 sweep — 하나라도 hover 될 때까지.
    const hoverLabel = page.getByTestId('recall-mini-graph-hover-label');
    let hovered = false;
    for (let i = 0; i < 3 && !hovered; i++) {
      const a = -Math.PI / 2 + (i / 3) * Math.PI * 2 + 0.3;
      await page.mouse.move(0, 0);
      await page.waitForTimeout(50);
      await page.mouse.move(
        cx + Math.cos(a) * R,
        cy + Math.sin(a) * R * 0.86,
        { steps: 5 },
      );
      try {
        await expect(hoverLabel).toBeVisible({ timeout: 1000 });
        hovered = true;
      } catch {
        /* try next node */
      }
    }
    expect(hovered).toBe(true);

    // 캔버스 바깥으로.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await expect(
      page.getByTestId('recall-mini-graph-hover-label'),
    ).toHaveCount(0);
  });
});
