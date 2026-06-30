/**
 * ★ feat/i18n-ko-display-names-separation (PO 2026-06-30) — i18n e2e #3.
 *
 * Acceptance #3 (★ PO verbatim):
 *   카드·툴팁·빈상태에 영문 코드 잔재 0
 *
 * 검증 surface:
 *   1. STELLAR EntityCard 헤더 = "지식그래프 · 엔티티" (옛 "STELLAR · ENTITY" 폐기).
 *   2. EntityCard 딥링크 = "기록에서 보기" / "검색에서 보기" (옛 LEDGER/RECALL 폐기).
 *   3. entity_type display = 한국어 (organization → 조직 등). raw token 은
 *      data-entity-type 으로 보존.
 *   4. EntityCard 전체 텍스트에 코드네임 (STELLAR/LEDGER/RECALL) 0.
 *
 * Screenshot 의무: 1 장 (EntityCard 한국어).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('★ i18n entity card: 헤더 / 딥링크 / type label 한국어 (영문 코드 0)', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // entity 검색 → 첫 결과 클릭 → EntityCard 마운트.
  const search = page.getByTestId('stellar-search-input');
  await search.fill('Alpha');
  const firstResult = page.getByTestId('stellar-search-result').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click({ force: true });

  const card = page.getByTestId('stellar-entity-card');
  await expect(card).toBeVisible();

  // 1. EntityCard 헤더 = "지식그래프 · 엔티티".
  await expect(card).toContainText('지식그래프 · 엔티티');

  // 2. 딥링크 라벨 = 한국어 ("기록 에서 보기" / "검색 에서 보기").
  await expect(page.getByTestId('stellar-entity-card-ledger-link')).toContainText('기록 에서 보기');
  await expect(page.getByTestId('stellar-entity-card-recall-link')).toContainText('검색 에서 보기');

  // 3. ★ 카드 전체 텍스트에 영문 코드네임 노출 0.
  const cardText = (await card.textContent()) ?? '';
  expect(cardText).not.toMatch(/STELLAR|LEDGER|RECALL|HEARTH|HARVEST|DECIDE/);
  // 영문 entity_type token (person/organization/group/place 등) 노출 0.
  // 단, 실제 entity name 안에 영문이 있을 수 있어 entity-type element 만 별도 검사.
  const typeEl = page.getByTestId('stellar-entity-card-type');
  if (await typeEl.isVisible()) {
    const typeText = (await typeEl.textContent()) ?? '';
    // 한국어만.
    expect(typeText).not.toMatch(/person|organization|group|place|concept|knowledge|resource|product/i);
    // ★ 내부 raw token 은 data-entity-type 으로 보존 (회귀 0).
    const rawType = await typeEl.getAttribute('data-entity-type');
    expect(rawType).toBeTruthy();
  }

  await captureEvidence(page, 'i18n-ko-entity-card', '01-entity-card-korean');
});
