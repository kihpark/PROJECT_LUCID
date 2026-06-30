/**
 * ★ feat/i18n-ko-display-names-separation (PO 2026-06-30) — i18n e2e #1.
 *
 * Acceptance #1 (★ PO verbatim):
 *   네비 = 홈·검색·지식그래프·검증·기록 (영문 0)
 *
 * (PO 의뢰서 표 6 항목 중 HARVEST/수집 은 routed 표면이 없어 nav 미포함 —
 *  displayNames helper 에 매핑은 유지. routed 표면 추가 시 nav 자동 노출.)
 *
 * Screenshot 의무: 1 장 (네비 한국어 표시).
 */
import { test, expect } from './fixtures/auth';
import { captureEvidence } from './helpers/screenshot';

test('★ i18n nav: 메뉴 한국어 표시 — 홈/검색/지식그래프/검증/기록 (영문 코드 0)', async ({
  authenticatedPage: page,
}) => {
  await page.goto('/home');
  await page.waitForLoadState('networkidle');

  const nav = page.getByTestId('app-shell-nav');
  await expect(nav).toBeVisible();

  // 1. 한국어 표시명 (★ PO 의뢰서 verbatim) 노출 확인.
  await expect(page.getByTestId('app-shell-nav-home')).toContainText('홈');
  await expect(page.getByTestId('app-shell-nav-recall')).toContainText('검색');
  await expect(page.getByTestId('app-shell-nav-stellar')).toContainText('지식그래프');
  await expect(page.getByTestId('app-shell-nav-pending')).toContainText('검증');
  await expect(page.getByTestId('app-shell-nav-ledger')).toContainText('기록');

  // 2. ★ 영문 코드네임 (HEARTH / RECALL / STELLAR / DECIDE / LEDGER /
  //    HARVEST / Recall / Stellar / …) 노출 0.
  const navText = (await nav.textContent()) ?? '';
  expect(navText).not.toMatch(/HEARTH|HARVEST|DECIDE|RECALL|STELLAR|LEDGER/);
  expect(navText).not.toMatch(/Recall|Stellar|Hearth|Harvest|Decide|Ledger/);
  expect(navText).not.toMatch(/Pending/);

  // 3. 내부 라우트 (코드네임) 유지 검증 — href 는 그대로.
  await expect(page.getByTestId('app-shell-nav-recall')).toHaveAttribute('href', '/recall');
  await expect(page.getByTestId('app-shell-nav-stellar')).toHaveAttribute('href', '/stellar');
  await expect(page.getByTestId('app-shell-nav-pending')).toHaveAttribute('href', '/pending');
  await expect(page.getByTestId('app-shell-nav-ledger')).toHaveAttribute('href', '/ledger');

  await captureEvidence(page, 'i18n-ko-nav', '01-nav-korean-labels');
});
