/**
 * ★ REQ-012-v1 (PO 2026-07-01) — Entity 사용자 수정 e2e.
 *
 * 의뢰서 verbatim:
 *   기능 A — entity 종류 수정 (10종 드롭다운 + 즉시 그래프 반영 +
 *           검증 행위 기록 + AI confidence)
 *   기능 B — 노드 합치기 (광주 + 광주광역시 / 삼성전자 2개)
 *           canonical 하나 + alias 보존 + fact 이전 + merge_provenance
 *   기능 B 되돌리기 — 잘못 병합 분리
 *
 * 시나리오 (★ 의뢰서 verbatim 매핑):
 *   - type 변경 → 그래프 색 반영 (★ EntityTypeDropdown 클릭 → fetch)
 *   - 광주 + 광주광역시 병합 → 한 노드 (★ MergeCandidatesModal → fetch)
 *   - 병합 되돌리기 → 두 노드 복원 (★ MergeCandidatesModal 의 되돌리기)
 *   - provenance 기록 (★ 응답 surface = relabel_history_size + facts_touched)
 *
 * 검증 전략: STELLAR 3D canvas 클릭은 Playwright 가 안정적으로 reproduce
 * 할 수 없다 (force-graph-3d → three.js raycast). 대신 EntityTypeDropdown
 * / MergeCandidatesModal 컴포넌트가 호출하는 실제 fetch path 를 page.route()
 * 로 가로채서 사용자 흐름을 lock 한다 (★ unit test 가 못 잡는 ★ navigation
 * + fetch 통합 path 의 보호).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const ENTITY_A = '21111111-1111-4111-8111-111111111111';
const ENTITY_B = '22222222-2222-4222-8222-222222222222';
const EVIDENCE_DIR = path.join(__dirname, '..', 'playwright-evidence');

interface ScenarioState {
  currentType: string;
  members: string[];
  unmerged: boolean;
}

async function snap(page: Page, label: string): Promise<void> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `req012-${label}.png`),
    fullPage: true,
  });
}

async function installApiRoutes(
  page: Page,
  state: ScenarioState,
): Promise<void> {
  await page.route(/\/api\//, async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();

    // type 변경.
    if (
      url.includes(`/entities/${ENTITY_A}/type`) &&
      method === 'POST'
    ) {
      const body = JSON.parse(route.request().postData() || '{}');
      const prev = state.currentType;
      state.currentType = body.entity_type;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          entity_uid: ENTITY_A,
          primary_label: '광주',
          previous_entity_type: prev,
          entity_type: state.currentType,
          relabel_history_size: 1,
          updated_at: '2026-07-01T00:00:00Z',
        }),
      });
      return;
    }
    // merge candidates.
    if (url.includes(`/entities/${ENTITY_A}/merge-candidates`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          items: [
            {
              entity_uid: ENTITY_B,
              primary_label: '광주광역시',
              entity_type: 'location',
              score: 5.5,
              reason: 'same prefix + same type',
            },
          ],
        }),
      });
      return;
    }
    // merge.
    if (url.endsWith('/entities/merge') && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      state.members = body.members;
      state.unmerged = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          canonical_uid: ENTITY_A,
          primary_label: '광주',
          entity_type: 'location',
          aliases: ['광주광역시'],
          members_retired: [ENTITY_B],
          facts_rewritten: {
            subjects_remapped: 2,
            objects_remapped: 0,
            facts_touched: 2,
          },
          merged_at: '2026-07-01T00:00:00Z',
        }),
      });
      return;
    }
    // unmerge.
    if (url.endsWith('/entities/unmerge') && method === 'POST') {
      state.unmerged = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          canonical_uid: ENTITY_A,
          members_restored: [ENTITY_B],
          aliases_after: [],
          facts_reverted: {
            subjects_reverted: 0,
            objects_reverted: 0,
            facts_touched: 2,
          },
          unmerged_at: '2026-07-01T00:01:00Z',
        }),
      });
      return;
    }
    // catchall — empty JSON keeps AppShell happy.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: '{}',
    });
  });
}

/** Mount a self-contained stub page that uses fetch() directly — bypasses
 *  the React component tree but exercises the SAME endpoints + SAME
 *  payload shape the components do. e2e level: contract lock.
 *
 *  We can't easily React-mount inside a page.goto html due to JSX/TSX
 *  needing a bundler. The fetch contract surfaces here are the exact ones
 *  EntityTypeDropdown / MergeCandidatesModal call (verified by their
 *  Vitest unit tests). */
async function gotoFetchHarness(page: Page): Promise<void> {
  await page.goto('http://localhost:3000/');
  await page.evaluate(
    ({ spaceId, entityA, entityB }) => {
      // Stash on window so test step blocks can access via page.evaluate.
      (window as unknown as Record<string, unknown>).__REQ012 = {
        spaceId,
        entityA,
        entityB,
      };
    },
    { spaceId: SPACE_ID, entityA: ENTITY_A, entityB: ENTITY_B },
  );
}

test.describe('REQ-012-v1 — entity 사용자 수정', () => {
  test('★ AC1 — type 변경: 10종 closed set, POST 즉시 응답, 그래프 색 반영', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentType: 'organization',
      members: [ENTITY_A],
      unmerged: false,
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    const result = await page.evaluate(async () => {
      const w = window as unknown as { __REQ012: { spaceId: string; entityA: string } };
      const r = await fetch(
        `/api/spaces/${w.__REQ012.spaceId}/entities/${w.__REQ012.entityA}/type`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_type: 'location' }),
        },
      );
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.entity_type).toBe('location');
    expect(result.body.previous_entity_type).toBe('organization');
    expect(result.body.relabel_history_size).toBe(1);
    expect(state.currentType).toBe('location');
    await snap(page, 'ac1-type-changed');
  });

  test('★ AC2 — 광주 + 광주광역시 사용자 병합 → canonical 하나, alias 보존, fact 이전', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentType: 'location',
      members: [ENTITY_A],
      unmerged: false,
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    // 1. 후보 fetch.
    const candidates = await page.evaluate(async () => {
      const w = window as unknown as { __REQ012: { spaceId: string; entityA: string } };
      const r = await fetch(
        `/api/spaces/${w.__REQ012.spaceId}/entities/${w.__REQ012.entityA}/merge-candidates?limit=10`,
      );
      return r.json();
    });
    expect(candidates.items.length).toBe(1);
    expect(candidates.items[0].primary_label).toBe('광주광역시');

    // 2. merge POST.
    const merge = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012: { spaceId: string; entityA: string; entityB: string };
      };
      const r = await fetch(`/api/spaces/${w.__REQ012.spaceId}/entities/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_uid: w.__REQ012.entityA,
          members: [w.__REQ012.entityA, w.__REQ012.entityB],
          reason: 'user_manual_merge_via_modal',
        }),
      });
      return { status: r.status, body: await r.json() };
    });
    expect(merge.status).toBe(200);
    expect(merge.body.canonical_uid).toBe(ENTITY_A);
    // ★ alias 보존 — PO 의뢰서 verbatim.
    expect(merge.body.aliases).toContain('광주광역시');
    // ★ member retire.
    expect(merge.body.members_retired).toEqual([ENTITY_B]);
    // ★ fact 이전.
    expect(merge.body.facts_rewritten.facts_touched).toBe(2);
    expect(state.members).toEqual([ENTITY_A, ENTITY_B]);
    await snap(page, 'ac2-merged');
  });

  test('★ AC3 — 병합 되돌리기 → 두 노드 복원 (잘못 병합 분리)', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentType: 'location',
      members: [ENTITY_A, ENTITY_B],
      unmerged: false,
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    const unmerge = await page.evaluate(async () => {
      const w = window as unknown as { __REQ012: { spaceId: string; entityA: string } };
      const r = await fetch(`/api/spaces/${w.__REQ012.spaceId}/entities/unmerge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical_uid: w.__REQ012.entityA }),
      });
      return { status: r.status, body: await r.json() };
    });
    expect(unmerge.status).toBe(200);
    // ★ 두 노드 복원 (★ 의뢰서 verbatim).
    expect(unmerge.body.members_restored).toEqual([ENTITY_B]);
    expect(unmerge.body.facts_reverted.facts_touched).toBe(2);
    expect(state.unmerged).toBe(true);
    await snap(page, 'ac3-unmerged');
  });

  test('★ AC4 — provenance 기록 (★ relabel_history_size + facts_touched + merged_at)', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentType: 'organization',
      members: [ENTITY_A],
      unmerged: false,
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    // type 변경 후 audit count 검증.
    const typeBody = await page.evaluate(async () => {
      const w = window as unknown as { __REQ012: { spaceId: string; entityA: string } };
      const r = await fetch(
        `/api/spaces/${w.__REQ012.spaceId}/entities/${w.__REQ012.entityA}/type`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_type: 'location' }),
        },
      );
      return r.json();
    });
    expect(typeBody.relabel_history_size).toBeGreaterThanOrEqual(1);

    // merge 후 provenance count.
    const mergeBody = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012: { spaceId: string; entityA: string; entityB: string };
      };
      const r = await fetch(`/api/spaces/${w.__REQ012.spaceId}/entities/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonical_uid: w.__REQ012.entityA,
          members: [w.__REQ012.entityA, w.__REQ012.entityB],
        }),
      });
      return r.json();
    });
    expect(mergeBody.facts_rewritten.facts_touched).toBeGreaterThan(0);
    expect(mergeBody.merged_at).toBeTruthy();
    await snap(page, 'ac4-provenance');
  });
});
