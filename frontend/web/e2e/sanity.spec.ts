import { test, expect } from './fixtures/auth';
import { captureEvidence } from './helpers/screenshot';

test.describe('★ Playwright infrastructure sanity', () => {
  test('홈 진입 + screenshot', async ({ authenticatedPage: page }) => {
    await page.goto('/home');
    await page.waitForLoadState('networkidle');
    await captureEvidence(page, 'sanity-home', '01-home-loaded');
    await expect(page).toHaveTitle(/Lucid|HEARTH/i);
  });

  test('STELLAR 진입 + REAL 모드 + screenshot', async ({ authenticatedPage: page }) => {
    await page.goto('/stellar');
    await page.waitForLoadState('networkidle');
    const realBtn = page.getByRole('button', { name: /REAL/i });
    if (await realBtn.isVisible()) {
      await realBtn.click();
    }
    await page.waitForTimeout(2000);
    await captureEvidence(page, 'sanity-stellar', '02-stellar-real');
  });

  test('RECALL 진입 + screenshot', async ({ authenticatedPage: page }) => {
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');
    await captureEvidence(page, 'sanity-recall', '03-recall-loaded');
  });
});
