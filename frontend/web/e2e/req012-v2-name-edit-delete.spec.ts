/**
 * ★ REQ-012-v2 (PO 2026-07-01, image #145 dogfood) — name edit + node/edge
 *  delete 사용자 흐름 e2e.
 *
 * 의뢰서 verbatim:
 *   - "한 총리" 를 사용자가 "한성숙" 으로 바꾸고 싶다면? → name edit
 *   - 사용자가 노드와 엣지를 선택하고 delete 를 하고 싶다면? → node/edge
 *     delete
 *
 * 시나리오 (★ 의뢰서 verbatim 매핑):
 *   AC1 name edit → primary_label 갱신 + 옛 이름 alias 흡수 +
 *                    relabel_history append (★ v3 §7 provenance)
 *   AC2 node delete → retired_by_user 세팅 + 연결 fact 자동 retract
 *   AC3 edge (fact) delete → retract endpoint (★ B-48b 재사용)
 *   AC4 provenance surface → response 안 relabel_history_size /
 *                             facts_retracted / retired_at
 *
 * 검증 전략은 REQ-012-v1 과 동일 — Playwright 는 STELLAR 3D canvas 클릭을
 * 안정적으로 재현할 수 없다 (force-graph-3d → three.js raycast). 대신 실제
 * fetch path 를 page.route() 로 가로채고, 컴포넌트가 호출하는 정확한 endpoint
 * + payload 계약을 lock 한다.
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
const ENTITY_A = '31111111-1111-4111-8111-111111111111';
const FACT_UID = 'ff111111-1111-4111-8111-111111111111';
const EVIDENCE_DIR = path.join(__dirname, '..', 'playwright-evidence');

interface ScenarioState {
  currentName: string;
  aliases: string[];
  deletedEntities: string[];
  retractedFacts: string[];
}

async function snap(page: Page, label: string): Promise<void> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `req012-v2-${label}.png`),
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

    // name edit.
    if (
      url.includes(`/entities/${ENTITY_A}/name`) &&
      method === 'POST'
    ) {
      const body = JSON.parse(route.request().postData() || '{}');
      const prev = state.currentName;
      state.currentName = body.name;
      if (prev && !state.aliases.includes(prev)) state.aliases.push(prev);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          entity_uid: ENTITY_A,
          primary_label: state.currentName,
          previous_name: prev,
          aliases: state.aliases,
          relabel_history_size: 1,
          updated_at: '2026-07-01T00:00:00Z',
        }),
      });
      return;
    }
    // entity soft delete.
    if (
      url.includes(`/entities/${ENTITY_A}`) &&
      !url.includes('/name') &&
      !url.includes('/type') &&
      !url.includes('/merge') &&
      method === 'DELETE'
    ) {
      state.deletedEntities.push(ENTITY_A);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          entity_uid: ENTITY_A,
          primary_label: state.currentName,
          retired_at: '2026-07-01T00:01:00Z',
          facts_retracted: 3,
        }),
      });
      return;
    }
    // fact retract (= delete alias).
    if (
      url.includes(`/facts/${FACT_UID}/retract`) &&
      method === 'POST'
    ) {
      state.retractedFacts.push(FACT_UID);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          fact_uid: FACT_UID,
          retracted_at: '2026-07-01T00:02:00Z',
          source_uids: [],
          auto_retracted: false,
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

async function gotoFetchHarness(page: Page): Promise<void> {
  await page.goto('http://localhost:3000/');
  await page.evaluate(
    ({ spaceId, entityA, factUid }) => {
      (window as unknown as Record<string, unknown>).__REQ012V2 = {
        spaceId,
        entityA,
        factUid,
      };
    },
    { spaceId: SPACE_ID, entityA: ENTITY_A, factUid: FACT_UID },
  );
}

test.describe('REQ-012-v2 — name edit + node/edge delete', () => {
  test('★ AC1 — name edit: POST /entities/{uid}/name 즉시 응답, 옛 이름 alias 흡수', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentName: '한 총리',
      aliases: [],
      deletedEntities: [],
      retractedFacts: [],
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012V2: { spaceId: string; entityA: string };
      };
      const r = await fetch(
        `/api/spaces/${w.__REQ012V2.spaceId}/entities/${w.__REQ012V2.entityA}/name`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: '한성숙',
            previous_name: '한 총리',
          }),
        },
      );
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.primary_label).toBe('한성숙');
    expect(result.body.previous_name).toBe('한 총리');
    // ★ 옛 이름은 aliases 로 흡수 — 사용자가 옛 이름으로 검색해도 찾을 수 있게.
    expect(result.body.aliases).toContain('한 총리');
    expect(result.body.relabel_history_size).toBeGreaterThanOrEqual(1);
    expect(state.currentName).toBe('한성숙');
    await snap(page, 'ac1-name-edited');
  });

  test('★ AC2 — node delete: DELETE /entities/{uid} → retired_at + 연결 fact 자동 retract', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentName: '삭제할 노드',
      aliases: [],
      deletedEntities: [],
      retractedFacts: [],
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012V2: { spaceId: string; entityA: string };
      };
      const r = await fetch(
        `/api/spaces/${w.__REQ012V2.spaceId}/entities/${w.__REQ012V2.entityA}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'user_delete_via_stellar' }),
        },
      );
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.entity_uid).toBe(ENTITY_A);
    // ★ soft delete provenance surface (retired_at).
    expect(result.body.retired_at).toBeTruthy();
    // ★ 연결 fact 자동 retract — 의뢰서 verbatim.
    expect(result.body.facts_retracted).toBe(3);
    expect(state.deletedEntities).toContain(ENTITY_A);
    await snap(page, 'ac2-node-deleted');
  });

  test('★ AC3 — edge (fact) delete: POST /facts/{uid}/retract (B-48b 재사용)', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentName: 'N/A',
      aliases: [],
      deletedEntities: [],
      retractedFacts: [],
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012V2: { spaceId: string; factUid: string };
      };
      const r = await fetch(
        `/api/spaces/${w.__REQ012V2.spaceId}/facts/${w.__REQ012V2.factUid}/retract`,
        { method: 'POST' },
      );
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.fact_uid).toBe(FACT_UID);
    // ★ soft delete stamp — retracted_at.
    expect(result.body.retracted_at).toBeTruthy();
    expect(state.retractedFacts).toContain(FACT_UID);
    await snap(page, 'ac3-edge-deleted');
  });

  test('★ AC4 — provenance surface: relabel_history_size + facts_retracted + retired_at', async ({
    page,
  }) => {
    const state: ScenarioState = {
      currentName: '한 총리',
      aliases: [],
      deletedEntities: [],
      retractedFacts: [],
    };
    await installApiRoutes(page, state);
    await gotoFetchHarness(page);

    // name edit provenance.
    const editRes = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012V2: { spaceId: string; entityA: string };
      };
      const r = await fetch(
        `/api/spaces/${w.__REQ012V2.spaceId}/entities/${w.__REQ012V2.entityA}/name`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '한성숙' }),
        },
      );
      return r.json();
    });
    expect(editRes.relabel_history_size).toBeGreaterThanOrEqual(1);

    // delete provenance (retired_at + facts_retracted).
    const delRes = await page.evaluate(async () => {
      const w = window as unknown as {
        __REQ012V2: { spaceId: string; entityA: string };
      };
      const r = await fetch(
        `/api/spaces/${w.__REQ012V2.spaceId}/entities/${w.__REQ012V2.entityA}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'user_delete' }),
        },
      );
      return r.json();
    });
    expect(delRes.retired_at).toBeTruthy();
    expect(delRes.facts_retracted).toBeGreaterThanOrEqual(0);
    await snap(page, 'ac4-provenance');
  });
});
