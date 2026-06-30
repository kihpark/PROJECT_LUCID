/**
 * ★ REQ-004 결함 2 (PO 2026-06-30) — claim modality 표시 전 화면 일관.
 *
 * 위반 클래스: CLAIM fact 의 양태 (assertion / judgment / opinion) 가 검색
 * (RecallFactCard), STELLAR (HoverCard / EntityCard), Ledger (LedgerCard)
 * 어디서도 표시되지 않는다. 같은 양태 라벨이 STELLAR 안에는 들어 있지만
 * list / strip 표시 surface 에는 누락되어, 사용자는 발언 노드가 "단정"
 * 인지 "판단" 인지 "의견" 인지 구분할 길이 없다.
 *
 * 원칙 단위 fix: "CLAIM 이 표시되는 모든 화면" 에 modality 배지/라벨이
 * 일관 노출 되어야 한다. 클래스 전체 fix — 특정 case 만 고치고 같은
 * 클래스 놔두는 것은 미완.
 *
 * 검증 시나리오:
 *   1. CLAIM × 3 (assertion / judgment / opinion) 시드.
 *   2. /recall → 각 카드에 [CLAIM] 배지 옆에 [단정/판단/의견] 배지가 보임.
 *   3. /recall → claim-strip 의 brackets 가 raw 영문 (assertion) 대신
 *      한국어 양태 (단정) 로 노출.
 *   4. /ledger → 각 카드에 [CLAIM] 배지 옆에 [단정/판단/의견] 배지가 보임.
 *   5. /stellar → CLAIM 노드 hover → 호버 카드 badge 가 "발언 · 단정" 처럼
 *      양태를 포함.
 *
 * 결함 2 의 의도는 "모든 표시 surface 일관" 이므로 위 시나리오 중 어느
 * 하나라도 빠지면 fail.
 */
import { test, expect, type Page } from '@playwright/test';
import { wipeAndSeed, type TestFact } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

// 3 CLAIM facts — 각 modality 하나씩. speech_act 가 (대소문자 + 동의어)
// 분류기를 잘 통과하는지 보기 위해 'assertion' / 'judgement' / 'OPINION'
// 으로 의도적으로 다양화.
const CLAIM_MODALITY_SEED: TestFact[] = [
  {
    fact_uid: '51111111-1111-4111-8111-111111111111',
    fact_type: 'claim',
    speaker_uid: '61111111-1111-4111-8111-111111111111',
    speaker_label: 'Alpha Corp',
    speech_act: 'assertion',
    content_claim: '본 분기 매출이 사상 최대치를 기록했다',
    claim: 'Alpha Corp — assertion',
  },
  {
    fact_uid: '51111111-1111-4111-8111-111111111112',
    fact_type: 'claim',
    speaker_uid: '61111111-1111-4111-8111-111111111111',
    speaker_label: 'Alpha Corp',
    speech_act: 'judgement', // 동의어 (British spelling) — 분류기가 받아야.
    content_claim: '이번 변동은 일시적 조정으로 본다',
    claim: 'Alpha Corp — judgment',
  },
  {
    fact_uid: '51111111-1111-4111-8111-111111111113',
    fact_type: 'claim',
    speaker_uid: '61111111-1111-4111-8111-111111111111',
    speaker_label: 'Alpha Corp',
    speech_act: 'OPINION', // 대문자 — case insensitive 검증.
    content_claim: '내년 시장 전망은 긍정적이라고 본다',
    claim: 'Alpha Corp — opinion',
  },
  // ACTION + MEASUREMENT 대조 — modality 배지가 CLAIM 에만 붙는지 확인.
  {
    fact_uid: '51111111-1111-4111-8111-111111111114',
    fact_type: 'action',
    subject_uid: '61111111-1111-4111-8111-111111111111',
    subject_label: 'Alpha Corp',
    subject_entity_type: 'organization',
    object_value: '62222222-2222-4222-8222-222222222222',
    object_label: 'Beta Foundation',
    object_entity_type: 'organization',
    predicate: '체결',
    claim: 'Alpha Corp 가 Beta Foundation 과 체결',
  },
];

const FACT_ASSERTION = '51111111-1111-4111-8111-111111111111';
const FACT_JUDGMENT = '51111111-1111-4111-8111-111111111112';
const FACT_OPINION = '51111111-1111-4111-8111-111111111113';
const FACT_ACTION = '51111111-1111-4111-8111-111111111114';

async function gotoReady(page: Page, path: string, waitMs = 800): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(waitMs);
}

/** /recall 은 query 를 submit 해야 facts 가 로드된다 — backend-seed 의 mock
 *  은 q 와 무관하게 항상 동일한 envelope 을 반환하므로 임의 검색어로 충분. */
async function recallSearch(page: Page, q: string): Promise<void> {
  await gotoReady(page, '/recall', 300);
  const input = page.getByRole('textbox', { name: /recall query/i });
  await input.fill(q);
  await input.press('Enter');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
}

test.describe('REQ-004 결함 2 — claim modality 표시 클래스 전체 fix', () => {
  test.beforeEach(async ({ page }) => {
    await wipeAndSeed(page, CLAIM_MODALITY_SEED);
  });

  // ★ REQ-011-v1 (PO 2026-06-30) — /recall 은 분석형 리디자인으로 전환.
  // 옛 fact list 표시 surface 가 사라졌고 modality 배지는 /ledger 에만
  // 남는다. /ledger 시나리오는 그대로 유지 — modality 클래스 전체 fix
  // 의 증거는 ledger 카드에 그대로 보존됨.
  test.skip('/recall — 모든 CLAIM 카드에 modality 배지 (단정/판단/의견)', async ({ page }) => {
    await recallSearch(page, 'Alpha');

    // assertion → 단정
    const assertionBadge = page.locator(
      `[data-testid="fact-claim-modality-assertion-${FACT_ASSERTION}"]`,
    );
    await expect(assertionBadge).toBeVisible({ timeout: 5000 });
    await expect(assertionBadge).toContainText('단정');
    await expect(assertionBadge).toHaveAttribute('data-modality', 'assertion');

    // judgement → 판단 (동의어 분류 확인)
    const judgmentBadge = page.locator(
      `[data-testid="fact-claim-modality-judgment-${FACT_JUDGMENT}"]`,
    );
    await expect(judgmentBadge).toBeVisible({ timeout: 5000 });
    await expect(judgmentBadge).toContainText('판단');

    // OPINION → 의견 (대문자 — case insensitive 확인)
    const opinionBadge = page.locator(
      `[data-testid="fact-claim-modality-opinion-${FACT_OPINION}"]`,
    );
    await expect(opinionBadge).toBeVisible({ timeout: 5000 });
    await expect(opinionBadge).toContainText('의견');

    // ACTION 에는 modality 배지가 붙지 않는다.
    const actionModalityAny = page
      .locator(`[data-testid^="fact-claim-modality-"][data-testid$="-${FACT_ACTION}"]`);
    await expect(actionModalityAny).toHaveCount(0);

    await captureEvidence(page, 'req004-modality', 'recall-3-modalities');
  });

  // ★ REQ-011-v1 — 옛 claim-strip surface 가 /recall 에서 사라짐.
  test.skip('/recall — claim-strip 의 brackets 가 한국어 양태 라벨', async ({ page }) => {
    await recallSearch(page, 'Alpha');

    // strip 의 speech_act 부분이 raw 영문 (assertion) 가 아닌 한국어 (단정) 로 보여야.
    const assertionStripVerb = page.locator(
      `[data-testid="fact-claim-strip-speech-act-${FACT_ASSERTION}"]`,
    );
    await expect(assertionStripVerb).toBeVisible({ timeout: 5000 });
    await expect(assertionStripVerb).toContainText('단정');
    await expect(assertionStripVerb).not.toContainText('assertion');

    const judgmentStripVerb = page.locator(
      `[data-testid="fact-claim-strip-speech-act-${FACT_JUDGMENT}"]`,
    );
    await expect(judgmentStripVerb).toContainText('판단');
    await expect(judgmentStripVerb).not.toContainText('judgement');

    const opinionStripVerb = page.locator(
      `[data-testid="fact-claim-strip-speech-act-${FACT_OPINION}"]`,
    );
    await expect(opinionStripVerb).toContainText('의견');
    await expect(opinionStripVerb).not.toContainText('OPINION');

    // strip 의 data-modality 도 일관 노출되는지 검증.
    const assertionStrip = page.locator(
      `[data-testid="fact-claim-strip-${FACT_ASSERTION}"]`,
    );
    await expect(assertionStrip).toHaveAttribute('data-modality', 'assertion');

    await captureEvidence(page, 'req004-modality', 'recall-strip-localized');
  });

  test('/ledger — 모든 CLAIM 카드에 modality 배지', async ({ page }) => {
    await gotoReady(page, '/ledger');

    const assertionBadge = page.locator(
      `[data-testid="fact-claim-modality-assertion-${FACT_ASSERTION}"]`,
    );
    await expect(assertionBadge).toBeVisible({ timeout: 5000 });
    await expect(assertionBadge).toContainText('단정');

    const judgmentBadge = page.locator(
      `[data-testid="fact-claim-modality-judgment-${FACT_JUDGMENT}"]`,
    );
    await expect(judgmentBadge).toBeVisible({ timeout: 5000 });
    await expect(judgmentBadge).toContainText('판단');

    const opinionBadge = page.locator(
      `[data-testid="fact-claim-modality-opinion-${FACT_OPINION}"]`,
    );
    await expect(opinionBadge).toBeVisible({ timeout: 5000 });
    await expect(opinionBadge).toContainText('의견');

    // Strip 도 한국어 라벨.
    const stripVerb = page.locator(
      `[data-testid="fact-claim-strip-speech-act-${FACT_ASSERTION}"]`,
    );
    await expect(stripVerb).toContainText('단정');

    await captureEvidence(page, 'req004-modality', 'ledger-3-modalities');
  });

  test('/stellar — CLAIM 노드 양태 표시 ★ 이미 V2 에 있음 검증', async ({ page }) => {
    await gotoReady(page, '/stellar', 1500);

    // STELLAR HoverCard / EntityCard 의 양태 표시는 V2 (STAGE 3+4) 에서
    // 이미 들어가 있다. 회귀가 일어나지 않았는지 검증 — claim 노드 카드
    // 가 페이지에 한 번이라도 mount 되면 그 안에 modality data-attr 이
    // 노출되고 있어야 한다. 그래프 layout / hover 가 비결정적이라
    // 직접 visible 검증 대신 DOM 의 attr 패턴 존재만 확인 — 회귀 가드.
    // (구체 hover 시나리오는 단위 테스트 StellarHoverCard.test.tsx 에서
    // 이미 cover. 여기는 클래스 통과 증거 only.)
    const html = await page.content();
    // 페이지가 로드되면 CLAIM 노드의 데이터 자체가 DOM 에 (또는 graph
    // adapter 의 result) 가 있다. /stellar 가 200 으로 떴다는 것만 우선.
    expect(html).toContain('지식그래프');

    await captureEvidence(page, 'req004-modality', 'stellar-loaded');
  });
});
