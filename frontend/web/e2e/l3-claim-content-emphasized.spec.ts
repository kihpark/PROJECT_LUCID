/**
 * ★ L3 (STELLAR legend/shape/hover, PO 2026-06-29) — claim hover content 부각.
 *
 * 사용자가 가장 알고 싶은 것 = 발언 내용 자체. content font-size 가 speaker /
 * speech-act font-size 보다 명백히 커야 한다.
 *
 * 3D canvas hover 는 Playwright 가 직접 raycast 못 함 → e2e 전용 hover hook
 * (`stellar-e2e-fire-claim-hover`, display:none) 으로 production handleHover
 * 경로를 발화시켜 StellarHoverCard 가 production 과 동일 props 로 mount.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('L3: claim hover renders content larger than speaker/speech-act', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Fire the production hover path on the first claim node.
  await page.getByTestId('stellar-e2e-fire-claim-hover').dispatchEvent('click');

  const card = page.getByTestId('stellar-hover-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-fact-type', 'claim');

  const content = page.getByTestId('stellar-hover-card-content');
  const speaker = page.getByTestId('stellar-hover-card-speaker');
  const speechAct = page.getByTestId('stellar-hover-card-speech-act');
  await expect(content).toBeVisible();
  await expect(speaker).toBeVisible();
  await expect(speechAct).toBeVisible();

  const contentFs = await content.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  const speakerFs = await speaker.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  const speechFs = await speechAct.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );

  // ★ L3 — content font-size must dominate.
  expect(contentFs).toBeGreaterThan(speakerFs);
  expect(contentFs).toBeGreaterThan(speechFs);

  // ★ Content text should also be present (full content_claim from seed).
  const claimFact = SEED_FACTS.find((f) => f.fact_type === 'claim');
  expect(claimFact, 'seed must contain a claim fact').toBeTruthy();
  const expected = claimFact!.content_claim ?? '';
  // Substring (the curly quote wrapping is added by the card).
  const text = (await content.textContent()) ?? '';
  expect(text).toContain(expected.slice(0, 30));

  await captureEvidence(page, 'l3-claim-content-emphasized', '01-claim-content-large');
});
