import { describe, expect, it } from 'vitest';
import {
  ACTION_EDGE_COLOR,
  CLAIM_EDGE_COLOR,
  edgeStyle,
  edgeStyleIgnoringLinkStatus,
  edgeStyleToCss,
  edgeWidth,
  nodeRadius,
} from '@/lib/stellarEdgeStyle';

describe('edgeWidth (log scale, clamped)', () => {
  it('1 fact → ~1.0', () => {
    expect(edgeWidth(1)).toBeCloseTo(1.0, 2);
  });

  it('10 facts → ~2.0 (one log decade up)', () => {
    expect(edgeWidth(10)).toBeCloseTo(2.0, 2);
  });

  it('100 facts → ~3.0 (two log decades up)', () => {
    expect(edgeWidth(100)).toBeCloseTo(3.0, 2);
  });

  it('clamps at the [0.8, 5.0] floor/ceiling', () => {
    expect(edgeWidth(0)).toBeGreaterThanOrEqual(0.8);
    expect(edgeWidth(1_000_000)).toBeLessThanOrEqual(5.0);
  });

  it('monotonically increasing across the unclamped band', () => {
    expect(edgeWidth(2)).toBeGreaterThan(edgeWidth(1));
    expect(edgeWidth(50)).toBeGreaterThan(edgeWidth(20));
  });
});

describe('nodeRadius (log scale, clamped to [4, 24])', () => {
  it('degree 1 → MIN (4)', () => {
    expect(nodeRadius(1)).toBe(4);
  });

  it('degree 50 → MAX (24)', () => {
    expect(nodeRadius(50)).toBeCloseTo(24, 5);
  });

  it('degree 200 → clamped to MAX (24)', () => {
    expect(nodeRadius(200)).toBe(24);
  });

  it('monotonically increases between 1 and 50', () => {
    const a = nodeRadius(5);
    const b = nodeRadius(15);
    const c = nodeRadius(40);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('handles 0 / negative input without NaN (clamped to MIN)', () => {
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(-10)).toBe(4);
    expect(Number.isFinite(nodeRadius(0))).toBe(true);
  });
});

describe('edgeStyle — ★ PO 정정: 모든 엣지 실선, opacity 1', () => {
  it('ACTION edge: solid, teal, opacity 1', () => {
    const s = edgeStyle('action', 1);
    expect(s.type).toBe('solid');
    expect(s.color).toBe(ACTION_EDGE_COLOR);
    expect(s.color).toBe('#5EEAD4');
    expect(s.opacity).toBe(1);
  });

  it('CLAIM related-to edge: ★ solid (NOT dashed), amber, opacity 1', () => {
    const s = edgeStyle('claim_related', 1);
    expect(s.type).toBe('solid');     // ★ PO 정정 핵심 가드
    expect(s.color).toBe(CLAIM_EDGE_COLOR);
    expect(s.color).toBe('#F5C36B');
    expect(s.opacity).toBe(1);         // ★ 흐림 폐기
  });

  it('★ neither edge kind ever returns dashed', () => {
    for (const kind of ['action', 'claim_related'] as const) {
      for (const fc of [1, 5, 20, 100, 9999]) {
        const s = edgeStyle(kind, fc);
        expect(s.type).toBe('solid');
        expect(s.opacity).toBe(1);
      }
    }
  });

  it('width scales with fact count, but color/style do not', () => {
    const s1 = edgeStyle('action', 1);
    const s100 = edgeStyle('action', 100);
    expect(s1.width).toBeLessThan(s100.width);
    expect(s1.color).toBe(s100.color);
    expect(s1.type).toBe(s100.type);
    expect(s1.opacity).toBe(s100.opacity);
  });

  it('color distinguishes ACTION vs CLAIM (행위 vs 발언 — color hue only)', () => {
    expect(edgeStyle('action', 1).color).not.toBe(edgeStyle('claim_related', 1).color);
  });
});

describe('★ link_status visual unbind (PO 정정 가드)', () => {
  it('returns identical style regardless of link_status value', () => {
    const verified = edgeStyleIgnoringLinkStatus('action', 5, 'verified');
    const claimed = edgeStyleIgnoringLinkStatus('action', 5, 'claimed');
    const nullStatus = edgeStyleIgnoringLinkStatus('action', 5, null);
    const undef = edgeStyleIgnoringLinkStatus('action', 5);
    expect(verified).toEqual(claimed);
    expect(verified).toEqual(nullStatus);
    expect(verified).toEqual(undef);
  });

  it('the same guarantee holds for CLAIM-related edges', () => {
    const v = edgeStyleIgnoringLinkStatus('claim_related', 3, 'verified');
    const c = edgeStyleIgnoringLinkStatus('claim_related', 3, 'claimed');
    expect(v).toEqual(c);
    expect(v.type).toBe('solid');
    expect(v.opacity).toBe(1);
  });

  it('★ neither verified nor claimed produces a dashed line', () => {
    expect(edgeStyleIgnoringLinkStatus('action', 1, 'verified').type).toBe('solid');
    expect(edgeStyleIgnoringLinkStatus('action', 1, 'claimed').type).toBe('solid');
    expect(edgeStyleIgnoringLinkStatus('claim_related', 1, 'verified').type).toBe('solid');
    expect(edgeStyleIgnoringLinkStatus('claim_related', 1, 'claimed').type).toBe('solid');
  });

  it('★ neither verified nor claimed produces opacity < 1', () => {
    expect(edgeStyleIgnoringLinkStatus('action', 1, 'verified').opacity).toBe(1);
    expect(edgeStyleIgnoringLinkStatus('action', 1, 'claimed').opacity).toBe(1);
  });

  it('★ neither verified nor claimed produces a grey de-emphasis color', () => {
    // The only legal colors are the action teal and claim amber.
    const legal = new Set([ACTION_EDGE_COLOR, CLAIM_EDGE_COLOR]);
    expect(legal.has(edgeStyleIgnoringLinkStatus('action', 1, 'verified').color)).toBe(true);
    expect(legal.has(edgeStyleIgnoringLinkStatus('action', 1, 'claimed').color)).toBe(true);
    expect(legal.has(edgeStyleIgnoringLinkStatus('claim_related', 1, 'verified').color)).toBe(true);
    expect(legal.has(edgeStyleIgnoringLinkStatus('claim_related', 1, 'claimed').color)).toBe(true);
  });
});

describe('edgeStyleToCss (SVG-ready, no dashArray)', () => {
  it('emits strokeDasharray: "none" for ACTION', () => {
    const css = edgeStyleToCss(edgeStyle('action', 1));
    expect(css.strokeDasharray).toBe('none');
    expect(css.strokeOpacity).toBe(1);
  });

  it('emits strokeDasharray: "none" for CLAIM-related (★ 점선 폐기)', () => {
    const css = edgeStyleToCss(edgeStyle('claim_related', 1));
    expect(css.strokeDasharray).toBe('none');   // ★ 핵심 가드
    expect(css.strokeOpacity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M3-2e regression guard - 정정 가드 강화 (PO 2026-06-28).
//
// PO 의뢰서 verbatim:
//   모든 fact = 실선 / 또렷. 점선 / 흐림 / 회색 금지.
//   link_status = 데이터 메타데이터 only.
//
// 위 명령을 m32b 가 이미 구현했지만, m32e 는 어떤 fact_count / 어떤
// link_status 가 들어와도 dashed / opacity<1 / grey 가 절대 등장하지
// 않는다는 회귀 가드를 추가한다.
// ---------------------------------------------------------------------------

describe('M3-2e regression guard - 정정 가드 강화', () => {
  it('어떤 fact_count 도 dashed 안 됨 (edgeStyleFor 의 모든 입력 -> type=solid)', () => {
    // fact_count 가 0, 음수, 매우 큰 수, fractional 까지 전체 range 를 훑는다.
    for (const kind of ['action', 'claim_related'] as const) {
      for (const fc of [-100, -1, 0, 0.4, 1, 2, 3, 5, 7, 10, 50, 100, 999, 9_999, 100_000, 1_000_000]) {
        const s = edgeStyle(kind, fc);
        expect(s.type).toBe('solid');
        // CSS 출력도 dashed 안 나옴.
        const css = edgeStyleToCss(s);
        expect(css.strokeDasharray).toBe('none');
      }
    }
  });

  it('어떤 link_status 도 opacity < 1 안 됨', () => {
    // verified / claimed / null / undefined / unknown string 모두 opacity=1.
    const linkStatuses: Array<'verified' | 'claimed' | string | null | undefined> = [
      'verified',
      'claimed',
      null,
      undefined,
      'pending',
      'archived',
      'unknown',
      '',
    ];
    for (const kind of ['action', 'claim_related'] as const) {
      for (const fc of [1, 3, 10, 50, 100]) {
        for (const status of linkStatuses) {
          const s = edgeStyleIgnoringLinkStatus(kind, fc, status as any);
          expect(s.opacity).toBe(1);
          expect(s.type).toBe('solid');
        }
      }
    }
  });

  it('★ link_status 시각 unbind 가드 강화: 어떤 verified vs claimed 비교도 deep equal', () => {
    // link_status 가 시각 어디에도 binding 안 됨을 deep-equality 로 확인.
    for (const kind of ['action', 'claim_related'] as const) {
      for (const fc of [1, 5, 100]) {
        const verified = edgeStyleIgnoringLinkStatus(kind, fc, 'verified');
        const claimed = edgeStyleIgnoringLinkStatus(kind, fc, 'claimed');
        const nullStatus = edgeStyleIgnoringLinkStatus(kind, fc, null);
        const pending = edgeStyleIgnoringLinkStatus(kind, fc, 'pending');
        expect(verified).toEqual(claimed);
        expect(verified).toEqual(nullStatus);
        expect(verified).toEqual(pending);
      }
    }
  });

  it('회색 회귀 가드: edgeStyle 의 color 는 항상 ACTION_EDGE_COLOR (teal) 또는 CLAIM_EDGE_COLOR (amber)', () => {
    // dim grey, neutral grey, mid-tone grey 같은 색이 등장하지 않음을 확인.
    const legal = new Set([ACTION_EDGE_COLOR, CLAIM_EDGE_COLOR]);
    for (const kind of ['action', 'claim_related'] as const) {
      for (const fc of [0, 1, 5, 50, 500, 5000]) {
        for (const status of ['verified', 'claimed', null, undefined, 'pending'] as const) {
          const s = edgeStyleIgnoringLinkStatus(kind, fc, status as any);
          expect(legal.has(s.color)).toBe(true);
        }
      }
    }
  });

  it('★ CSS 출력 회귀 가드: 어떤 입력에도 strokeDasharray 가 "none" 외 등장 안 함', () => {
    for (const kind of ['action', 'claim_related'] as const) {
      for (const fc of [0, 1, 10, 100, 9999]) {
        const css = edgeStyleToCss(edgeStyleIgnoringLinkStatus(kind, fc, 'verified'));
        expect(css.strokeDasharray).toBe('none');
        expect(css.strokeOpacity).toBe(1);
      }
    }
  });
});
