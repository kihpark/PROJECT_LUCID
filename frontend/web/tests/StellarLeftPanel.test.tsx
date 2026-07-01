/**
 * ★ REQ-013 (PO 2026-07-02) — StellarLeftPanel 필터 박스 폐기.
 *   기능은 StellarLegend 로 완전 이관 (각 row = clickable bucket toggle).
 *   원본 컴포넌트 파일 (StellarLeftPanel.tsx) 은 안전한 삭제를 위해 유지
 *   되지만 StellarView 는 더 이상 import 하지 않는다. 이 테스트는 실제
 *   대응 UI 가 사라졌으므로 skip 처리 (파일 자체는 회귀 안내용으로 남김).
 */
import { describe, it } from 'vitest';

describe.skip('StellarLeftPanel — REQ-013 폐기', () => {
  it('필터 UI 는 StellarLegend 로 통합됨', () => {
    // no-op — legend row 클릭 테스트는 StellarLegend 계열 스펙에서 담당.
  });
});
