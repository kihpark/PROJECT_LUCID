/**
 * ★ REQ-014-B (PO 2026-07-02) — DECIDE fact_type 별 편집 폼 e2e.
 *
 * 검증 항목:
 *   B1: ACTION       → ActionFactForm 렌더 (subject / predicate / object)
 *   B1: MEASUREMENT  → MeasurementFactForm 렌더 (subject / metric / value /
 *                      unit / as_of)
 *   B1: CLAIM        → ClaimFactForm 렌더 (speaker / speech_act /
 *                      content_claim / modality)
 *   B3: ACTION 배지 = 초록 (#10B981 verbatim)
 *   B4: subject 수정이 payload 에 실려 backend 로 전달됨 (subject_label +
 *       subject_uid 둘 다 edited_metadata 에 들어감)
 *
 * 시나리오 pattern:
 *   REQ-012-v2 spec 과 동일하게 page.route() 로 /api/* 를 가로챈다. Decide
 *   페이지는 SSR (headers().cookie) 를 통해 spaceId + jwt 를 읽고 pending
 *   detail 을 fetch 하므로, addCookies 로 두 값을 설정한 뒤 pending detail
 *   응답을 route 로 모의한다.
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
const JOB_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';

const SUBJECT_A = '41111111-1111-4111-8111-111111111111'; // 화웨이
const SUBJECT_A_NAME = '화웨이';
const OBJECT_A = '42222222-2222-4222-8222-222222222222'; // 반도체 사업
const OBJECT_A_NAME = '반도체 사업';

const ACTION_FACT_UID = '31111111-1111-4111-8111-111111111111';
const MEASUREMENT_FACT_UID = '31111111-1111-4111-8111-111111111112';
const CLAIM_FACT_UID = '31111111-1111-4111-8111-111111111113';

const EVIDENCE_DIR = path.join(__dirname, '..', 'playwright-evidence');

async function snap(page: Page, label: string): Promise<void> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `req014-b-${label}.png`),
    fullPage: true,
  });
}

interface CaptureState {
  submitted: unknown | null;
}

function pendingDetailBody() {
  return {
    job_id: JOB_ID,
    source_url: 'https://example.com/article/x',
    source_type: 'web',
    captured_at: '2026-07-02T00:00:00Z',
    captured_from: 'clipper',
    knowledge_space_id: SPACE_ID,
    extracted_text_preview: '...',
    facts: [
      {
        fact_uid: ACTION_FACT_UID,
        uid: ACTION_FACT_UID,
        claim: `${SUBJECT_A_NAME} | 인수했다 | ${OBJECT_A_NAME}`,
        claim_en: null,
        type: 'proposition',
        subject_uid: SUBJECT_A,
        predicate: '인수했다',
        object_value: OBJECT_A,
        negation_flag: false,
        negation_scope: null,
        fact_type: 'action',
      },
      {
        fact_uid: MEASUREMENT_FACT_UID,
        uid: MEASUREMENT_FACT_UID,
        claim: `${SUBJECT_A_NAME} 매출 = 100억`,
        claim_en: null,
        type: 'proposition',
        subject_uid: SUBJECT_A,
        predicate: '매출',
        object_value: '100억',
        negation_flag: false,
        negation_scope: null,
        fact_type: 'measurement',
        metric: '매출',
        measurement_value: 100,
        measurement_unit: '억',
        as_of: '2026-Q2',
      },
      {
        fact_uid: CLAIM_FACT_UID,
        uid: CLAIM_FACT_UID,
        claim: `${SUBJECT_A_NAME} 발표`,
        claim_en: null,
        type: 'proposition',
        subject_uid: SUBJECT_A,
        predicate: '발표했다',
        object_value: '',
        negation_flag: false,
        negation_scope: null,
        fact_type: 'claim',
        speaker_uid: SUBJECT_A,
        speaker_label: SUBJECT_A_NAME,
        speech_act: '발표했다',
        content_claim: '반도체 자립을 이루겠다',
      },
    ],
    objects: [
      {
        uid: SUBJECT_A,
        class: 'organization',
        name: SUBJECT_A_NAME,
        name_en: null,
        properties: {},
      },
      {
        uid: OBJECT_A,
        class: 'concept',
        name: OBJECT_A_NAME,
        name_en: null,
        properties: {},
      },
    ],
    fact_object_links: [],
    fact_fact_links: [],
    disambiguation_pending: [],
  };
}

async function installApiRoutes(page: Page, capture: CaptureState): Promise<void> {
  // /api/auth/me — SSR only reads cookies, but AppShell client component
  // still calls this. Return a signed-in user.
  await page.route(/\/api\/auth\/me$/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        id: USER_ID,
        email: 'kihpark85@gmail.com',
        current_space_id: SPACE_ID,
      }),
    });
  });
  await page.route(/\/api\/spaces\/me$/, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify([
        { id: SPACE_ID, type: 'personal', name: 'Seed', user_id: USER_ID },
      ]),
    });
  });
  // Pending detail — the SSR call.
  await page.route(
    new RegExp(`/api/spaces/[^/]+/pending/${JOB_ID}(\\?.*)?$`),
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify(pendingDetailBody()),
      });
    },
  );
  // Decide submit — capture the payload.
  await page.route(
    new RegExp(`/api/spaces/[^/]+/pending/${JOB_ID}/decide(\\?.*)?$`),
    async (route: Route) => {
      try {
        capture.submitted = JSON.parse(route.request().postData() || '{}');
      } catch {
        capture.submitted = null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({
          accepted_facts: [ACTION_FACT_UID],
          edited_facts: [],
          discarded_facts: [MEASUREMENT_FACT_UID, CLAIM_FACT_UID],
        }),
      });
    },
  );
  // Catchall — keep AppShell / brief happy.
  await page.route(/\/api\/.*/, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: CORS, body: '{}' });
  });
}

async function seedAuthCookies(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: 'lucid_space_id',
      value: SPACE_ID,
      domain: 'localhost',
      path: '/',
      sameSite: 'Lax',
    },
    {
      name: 'lucid_jwt',
      value: 'test-token',
      domain: 'localhost',
      path: '/',
      sameSite: 'Lax',
    },
  ]);
}

test.describe('REQ-014-B — DECIDE fact_type 별 편집 폼', () => {
  test('★ B3 — ACTION 배지 색이 emerald(#10B981) 로 렌더된다', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const badge = page.locator(`[data-testid="fact-action-badge-${ACTION_FACT_UID}"]`);
    await expect(badge).toBeVisible();
    // ★ B3 verbatim — data-fact-badge-color attr 로 색 코드를 e2e 가 검증한다.
    await expect(badge).toHaveAttribute('data-fact-badge-color', '#10B981');
    await snap(page, 'b3-action-badge-emerald');
  });

  test('★ B1 — ACTION fact 를 Edit 하면 ActionFactForm 이 렌더된다', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const actionCard = page.locator(`[data-testid="fact-card-${ACTION_FACT_UID}"]`);
    await expect(actionCard).toBeVisible();
    await actionCard.getByRole('button', { name: 'Edit' }).click();

    const form = page.locator(`[data-testid="fact-action-form-${ACTION_FACT_UID}"]`);
    await expect(form).toBeVisible();
    // subject / predicate / object 3 필드가 모두 있음
    await expect(page.locator(`[data-testid="fact-edit-subject-${ACTION_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-edit-predicate-${ACTION_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-edit-object-${ACTION_FACT_UID}"]`)).toBeVisible();
    // Measurement / Claim 폼은 렌더되면 안 됨
    await expect(page.locator(`[data-testid="fact-measurement-form-${ACTION_FACT_UID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="fact-claim-form-${ACTION_FACT_UID}"]`)).toHaveCount(0);
    await snap(page, 'b1-action-form');
  });

  test('★ B1 — MEASUREMENT fact 를 Edit 하면 MeasurementFactForm 이 렌더된다', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator(`[data-testid="fact-card-${MEASUREMENT_FACT_UID}"]`);
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Edit' }).click();

    const form = page.locator(`[data-testid="fact-measurement-form-${MEASUREMENT_FACT_UID}"]`);
    await expect(form).toBeVisible();
    // subject + metric + value + unit + as_of 5 필드
    await expect(page.locator(`[data-testid="fact-form-metric-input-${MEASUREMENT_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-form-value-input-${MEASUREMENT_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-form-unit-input-${MEASUREMENT_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-form-asof-input-${MEASUREMENT_FACT_UID}"]`)).toBeVisible();
    await snap(page, 'b1-measurement-form');
  });

  test('★ B1 — CLAIM fact 를 Edit 하면 ClaimFactForm 이 렌더된다', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator(`[data-testid="fact-card-${CLAIM_FACT_UID}"]`);
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Edit' }).click();

    const form = page.locator(`[data-testid="fact-claim-form-${CLAIM_FACT_UID}"]`);
    await expect(form).toBeVisible();
    // speaker + speech_act + content_claim + modality
    await expect(page.locator(`[data-testid="fact-form-speech-act-input-${CLAIM_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-form-content-claim-input-${CLAIM_FACT_UID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="fact-form-modality-select-${CLAIM_FACT_UID}"]`)).toBeVisible();
    await snap(page, 'b1-claim-form');
  });

  test('★ B2 — entity 옆에 entity_type 한국어 배지(10종)가 표시된다', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator(`[data-testid="fact-card-${ACTION_FACT_UID}"]`);
    await card.getByRole('button', { name: 'Edit' }).click();

    // 화웨이 는 organization → '조직'
    const subjectBadge = page.locator(
      `[data-testid="fact-form-subject-entity-type-${ACTION_FACT_UID}"]`,
    );
    await expect(subjectBadge).toBeVisible();
    await expect(subjectBadge).toHaveText('조직');
    // 반도체 사업 은 concept → '개념'
    const objectBadge = page.locator(
      `[data-testid="fact-form-object-entity-type-${ACTION_FACT_UID}"]`,
    );
    await expect(objectBadge).toBeVisible();
    await expect(objectBadge).toHaveText('개념');
    await snap(page, 'b2-entity-type-badges');
  });

  test('★ B4 — subject 수정이 edited_metadata 에 실려 제출된다', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator(`[data-testid="fact-card-${ACTION_FACT_UID}"]`);
    await card.getByRole('button', { name: 'Edit' }).click();
    // 옛 버그: "화웨" 로 저장했는데 검색 시 여전히 "화웨" — subject_label 이
    // Recall PATCH endpoint 에 없었기 때문. Decide 경로 는 edited_metadata 로
    // subject_label 을 함께 실어보내야 문서 surface 가 갱신된다.
    const subjectInput = page.locator(
      `[data-testid="fact-edit-subject-${ACTION_FACT_UID}"]`,
    );
    await subjectInput.fill('화웨이');
    await card.getByRole('button', { name: '저장' }).click();

    await page.getByRole('button', { name: /Submit decisions/i }).click();
    // wait for the submit to fire
    await page.waitForFunction(() => true, {}, { timeout: 100 });
    await expect
      .poll(() => capture.submitted, { timeout: 5000 })
      .not.toBeNull();

    const submitted = capture.submitted as { decisions: Array<{
      fact_uid: string;
      action: string;
      edited_metadata?: Record<string, unknown>;
    }> };
    const actionDecision = submitted.decisions.find((d) => d.fact_uid === ACTION_FACT_UID);
    expect(actionDecision).toBeTruthy();
    expect(actionDecision?.action).toBe('edit');
    // ★ B4 fix — subject_label 이 edited_metadata 로 함께 전달된다.
    expect(actionDecision?.edited_metadata).toBeTruthy();
    expect(actionDecision?.edited_metadata?.subject_label).toBe('화웨이');
    await snap(page, 'b4-subject-edit-payload');
  });

  test('★ B4 — subject rename 안내 링크가 표시된다 (EntityNameEdit 경로 유도)', async ({ page }) => {
    const capture: CaptureState = { submitted: null };
    await installApiRoutes(page, capture);
    await seedAuthCookies(page);
    await page.goto(`/pending/${JOB_ID}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator(`[data-testid="fact-card-${ACTION_FACT_UID}"]`);
    await card.getByRole('button', { name: 'Edit' }).click();
    // subject 는 UUID entity 를 가리키므로 rename 안내가 렌더된다.
    const notice = page.locator('[data-testid="fact-form-subject-rename-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('지식그래프');
    await snap(page, 'b4-rename-notice');
  });
});
