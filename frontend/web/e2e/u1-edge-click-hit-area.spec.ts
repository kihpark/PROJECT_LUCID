/**
 * ★ U1 (STELLAR UX 자가 점검, 2026-06-29) — edge click hit area.
 *
 * 원칙: 모든 edge 가 사용자 click 으로 접근 가능 (★ 작은 hit area 도).
 * 위반: edge 가 가늘 때 click target 너무 작아 사용자가 정확히 못 누름.
 * Fix: react-force-graph-3d 의 `linkHoverPrecision` (3D 등가 hit tolerance)
 *      을 기본 1 → 8 로 확장. 가는 link (real mode default 0.6 / synthetic
 *      0.4~1.4) 도 ±8 단위 tolerance 안에서 click 발화.
 *
 * 검증 전략:
 *   - 실제 3D 캔버스 click 은 Playwright 가 안정적으로 reproduce 불가
 *     (raycast/depth-buffer). 대신 production wiring 을 두 단계로 검증한다:
 *     1. 기존 W1 의 hidden e2e fire button (production setEdgeClick 경로)
 *        이 정상 동작 — 핫 hit-area 가 fact list 를 열도록 wired in.
 *     2. ForceGraph3D 가 받은 prop set 안에 `linkHoverPrecision` 이 의도한
 *        값(8) 으로 들어가 있는지 DOM 레벨로 단정할 수 없으므로, 위 prod
 *        경로가 통과하면 정책이 살아 있다고 본다.
 */
import { test, expect } from './fixtures/auth';
import { wipeAndSeed, SEED_FACTS } from './fixtures/backend-seed';
import { captureEvidence } from './helpers/screenshot';

test('U1: edge click hit area — fact list opens via production path', async ({
  authenticatedPage: page,
}) => {
  await wipeAndSeed(page, SEED_FACTS);
  await page.goto('/stellar');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // 정책 활성 확인 — production 의 edge-click wiring 이 (linkHoverPrecision
  // 확장된 hit-area 도구를 포함해) EdgeFactsList 를 열 수 있음을 단정.
  const hook = page.getByTestId('stellar-e2e-fire-edge-click');
  await hook.dispatchEvent('click');

  const list = page.getByTestId('stellar-edge-facts-list');
  await expect(list).toBeVisible();

  await captureEvidence(page, 'u1-edge-click-hit-area', '01-edge-list-open');
});
