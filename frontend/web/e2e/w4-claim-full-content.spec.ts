/**
 * ★ W4 (STELLAR 6-class fix, 2026-06-29) — claim full content (no truncation).
 *
 * Searches for a fragment of the long claim content_claim → clicks the
 * search result → claim card mounts → assert that the rendered content
 * div carries data-content-length === content_claim.length AND does NOT
 * contain the ellipsis '…' (U+2026).
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('W4: claim card renders full content_claim without truncation', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const claimFact = SEED_FACTS.find((f) => f.fact_type === 'claim');
  expect(claimFact, 'seed must contain a claim fact').toBeTruthy();
  const expected = claimFact!.content_claim ?? '';
  // The CLAIM node-label slice is 30 chars (stellarRealAdapter); any
  // content longer than that proves W4 (no truncation on FE render).
  expect(
    expected.length,
    'claim content should be > 30 chars (label slice boundary)',
  ).toBeGreaterThan(30);

  // Search by the speaker label (which is the claim node's label/subject
  // in the synthetic search field) — search hay is label+subject+object,
  // and the claim node carries the speaker label in the synthetic graph.
  // We try multiple queries to be resilient to label slicing in the
  // adapter (claim node labels are truncated to 30 chars).
  const search = page.getByTestId('stellar-search-input');
  await search.fill('매출');
  await page.waitForTimeout(500);

  // Click the first result that mentions claim text.
  const firstResult = page.getByTestId('stellar-search-result').first();
  await expect(firstResult).toBeVisible();
  await firstResult.click({ force: true });

  const claimCard = page.getByTestId('stellar-entity-card-claim');
  await expect(claimCard).toBeVisible();

  const contentDiv = page.getByTestId('stellar-entity-card-claim-content');
  await expect(contentDiv).toBeVisible();

  const renderedLen = await contentDiv.getAttribute('data-content-length');
  expect(renderedLen).not.toBeNull();
  expect(Number(renderedLen)).toBe(expected.length);

  const text = (await contentDiv.textContent()) ?? '';
  // The card wraps the content in “…” curly quotes — those are U+201C/U+201D,
  // NOT the truncation ellipsis U+2026. Assert no '…' present.
  expect(text.includes('…')).toBe(false);

  await captureEvidence(page, 'w4-claim-full-content', '01-full-claim-rendered');
});
