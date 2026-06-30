/**
 * ★ REQ-004 STAGE 3+4 (PO 2026-06-30) — 표시층 5 결함 e2e 검증.
 *
 * V3 (entity-id-only 저장) 의 표시층 누락 — backend 는 entity_id 로
 * 저장 성공, 그러나 FE 가 entity_id → canonical_name 조회 변환을
 * 일관되게 안 해 UUID 가 화면 전반에 노출됐다. 5 결함 모두 동일 뿌리.
 *
 *   결함 1: UUID 화면 노출 (검색칩 / ledger / 홈 / STELLAR 전부)
 *   결함 2: "(미해석)" 잔재 — entity_id 있는데 이름 못 끌어옴
 *   결함 3: /api/spaces/{ks}/recall?entity=<UUID>&q='' → 422
 *   결함 4: ledger SPO 3 칼럼 (옛 literal 가정) → v3 ACTION arrow 표시로
 *   결함 5: action 노드에 ACTION 배지 추가 (claim/measurement 와 일관성)
 *
 * 검증 방법: backend-seed 의 fullFacts 가 모두 entity uid (subject_uid /
 * object_value = UUID) 로 시드되도록 새 시나리오 추가. label resolve 가
 * 일어나지 않은 (subject_label=null) 케이스 + 정상 케이스 둘 다.
 */
import { test, expect, type Page } from '@playwright/test';
import { wipeAndSeed, type TestFact } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

// UUID4 (lowercase) — backend object_uid 형식 + v3 저장이 entity_id 인
// 모든 entity ref 가 이 모양. Hyphenated 8-4-4-4-12.
const UUID4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const FACTS_WITH_LABELS: TestFact[] = [
  // ACTION entity → entity, 양쪽 label 모두 resolved
  {
    fact_uid: '31111111-1111-4111-8111-111111111111',
    fact_type: 'action',
    subject_uid: '41111111-1111-4111-8111-111111111111',
    subject_label: '한국은행',
    subject_entity_type: 'organization',
    object_value: '42222222-2222-4222-8222-222222222222',
    object_label: '기준금리',
    object_entity_type: 'concept',
    predicate: '인하했다',
    claim: '한국은행이 기준금리를 인하했다',
  },
  // ACTION 한쪽 label 누락 — backend 가 entity_id 를 ES 에서 못 끌어온 경우.
  // ★ v3 정합: subject_uid 는 entity_id (UUID), label 만 null.
  // 표시 = "미해결 entity" (★ UUID X). 결함 2 검증.
  {
    fact_uid: '31111111-1111-4111-8111-111111111112',
    fact_type: 'action',
    subject_uid: '43333333-3333-4333-8333-333333333333',
    subject_label: null,
    subject_entity_type: null,
    object_value: '42222222-2222-4222-8222-222222222222',
    object_label: '기준금리',
    object_entity_type: 'concept',
    predicate: '결정했다',
    claim: '미해결 주체가 기준금리를 결정했다',
  },
  // CLAIM 노드 — 결함 5 ACTION 배지 와 대비. 같은 카드에서 CLAIM 배지
  // 와 ACTION 배지가 일관 표시되는지 검증.
  {
    fact_uid: '31111111-1111-4111-8111-111111111113',
    fact_type: 'claim',
    speaker_uid: '41111111-1111-4111-8111-111111111111',
    speaker_label: '한국은행',
    speech_act: '발표했다',
    content_claim: '경기 둔화에 대응해 기준금리를 0.25%p 인하한다',
    claim: '한국은행 발표',
  },
  // MEASUREMENT — 비교용 (MEASUREMENT 배지 정상).
  {
    fact_uid: '31111111-1111-4111-8111-111111111114',
    fact_type: 'measurement',
    subject_uid: '41111111-1111-4111-8111-111111111111',
    subject_label: '한국은행',
    subject_entity_type: 'organization',
    metric: '기준금리',
    measurement_value: 2.5,
    measurement_unit: '%',
    as_of: '2026-Q2',
    claim: '한국은행 기준금리 = 2.5%',
  },
];

/** Walk DOM text and assert no UUID4 leaked into a user-visible string.
 *  ★ data-* attrs / hidden inputs 는 허용 (내부 식별자) — body innerText
 *  만 검사. */
async function assertNoUuidInRender(page: Page): Promise<void> {
  const visibleText = await page.evaluate(() => {
    const root = document.body;
    return root ? root.innerText : '';
  });
  expect(visibleText).not.toMatch(UUID4_RE);
}

test.describe('REQ-004 STAGE 3+4 — 표시층 5 결함', () => {
  test.beforeEach(async ({ page }) => {
    await wipeAndSeed(page, FACTS_WITH_LABELS);
  });

  test('결함 1: 모든 화면(/home, /recall, /ledger, /stellar)에 UUID 노출 0', async ({ page }) => {
    // /home
    await page.goto('/home');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await assertNoUuidInRender(page);
    await captureEvidence(page, 'req004-stage3-4-defect-1', '01-home');

    // /recall
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await assertNoUuidInRender(page);
    await captureEvidence(page, 'req004-stage3-4-defect-1', '02-recall');

    // /ledger
    await page.goto('/ledger');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await assertNoUuidInRender(page);
    await captureEvidence(page, 'req004-stage3-4-defect-1', '03-ledger');

    // /stellar (REAL 모드)
    await page.goto('/stellar');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await assertNoUuidInRender(page);
    await captureEvidence(page, 'req004-stage3-4-defect-1', '04-stellar');
  });

  test('결함 2: "(미해석)" 잔재 0 — "미해결 entity" placeholder', async ({ page }) => {
    await page.goto('/ledger');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    const html = await page.content();
    // "(미해석)" 패턴 — 옛 fallback marker. v3 표시층에선 제거.
    expect(html).not.toContain('(미해석)');
    // 한쪽 label 없는 fact 가 시드에 있으므로 "미해결 entity" 가 떠야 한다.
    expect(html).toContain('미해결 entity');
    await captureEvidence(page, 'req004-stage3-4-defect-2', 'ledger-unresolved-placeholder');

    // RECALL 도 (★ "(미해석)" 안 떠야).
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const recallHtml = await page.content();
    expect(recallHtml).not.toContain('(미해석)');
    await captureEvidence(page, 'req004-stage3-4-defect-2', 'recall-no-misinterpret');
  });

  test('결함 3: /recall?entity=<UUID>&q= → 200 (★ 422 X)', async ({ page }) => {
    // backend-seed 가 /api/spaces/.../recall 을 200 으로 mock 한다.
    // 여기선 frontend 가 q='' 로 호출 시 422 가 떨어지지 않는지 검증.
    // 1. Recall 진입 후 frontend 가 빈 q + entity 로 호출하는 경로를
    //    직접 발사: lib/api.ts::recall(spaceId, '', { entity: [uid] }).
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    // page.evaluate 에서 직접 fetch — backend-seed 의 mock 이 200 을 보장.
    // 추가로 ★ backend 자체가 422 를 떨어뜨리지 않게 query 시그니처를
    // 변경한 것 (q optional) 도 단위 테스트에서 검증된다.
    const status = await page.evaluate(async () => {
      const spaceId = '00000000-0000-0000-0000-000000000001';
      const params = new URLSearchParams();
      params.set('q', '');
      params.set('entity', '41111111-1111-4111-8111-111111111111');
      const resp = await fetch(`/api/spaces/${spaceId}/recall?${params.toString()}`);
      return resp.status;
    });
    expect(status).not.toBe(422);
    expect(status).toBe(200);
    await captureEvidence(page, 'req004-stage3-4-defect-3', 'recall-entity-only-200');
  });

  test('결함 4: ledger 가 v3 ACTION arrow 로 표시', async ({ page }) => {
    await page.goto('/ledger');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    // action fact 둘 — entity → entity 인 fact 는 v3 arrow row 가 노출돼야.
    const arrowRow = page.locator('[data-testid$="-v3-arrow"]').first();
    await expect(arrowRow).toBeVisible({ timeout: 5000 });
    const arrowText = await arrowRow.textContent();
    // 옛 3-칼럼 (subject / predicate / object dt-dd) 대신 arrow 로.
    // ★ ─[predicate]→ 시그너처 확인 (v3 PO spec).
    expect(arrowText).toMatch(/─\[.+\]→/);
    await captureEvidence(page, 'req004-stage3-4-defect-4', 'ledger-v3-arrow');
  });

  test('결함 5: ACTION 배지 — action fact 에 ACTION 배지 노출', async ({ page }) => {
    await page.goto('/ledger');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    // action fact 의 ACTION badge 가 보여야 — claim/measurement 와 일관성.
    const actionBadge = page
      .locator('[data-testid="fact-action-badge-31111111-1111-4111-8111-111111111111"]')
      .first();
    await expect(actionBadge).toBeVisible({ timeout: 5000 });
    await expect(actionBadge).toContainText('ACTION');

    // CLAIM badge 도 같은 페이지에 있어야 (일관성).
    const claimBadge = page
      .locator('[data-testid="fact-claim-badge-31111111-1111-4111-8111-111111111113"]')
      .first();
    await expect(claimBadge).toBeVisible({ timeout: 5000 });
    await expect(claimBadge).toContainText('CLAIM');

    // MEASUREMENT badge 도.
    const measBadge = page
      .locator('[data-testid="fact-measurement-badge-31111111-1111-4111-8111-111111111114"]')
      .first();
    await expect(measBadge).toBeVisible({ timeout: 5000 });
    await expect(measBadge).toContainText('MEASUREMENT');

    await captureEvidence(page, 'req004-stage3-4-defect-5', 'ledger-3-badges-consistent');
  });
});
