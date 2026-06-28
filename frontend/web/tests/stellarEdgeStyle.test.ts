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

  it('color distinguishes ACTION vs CLAIM (행위 vs 발화 — color hue only)', () => {
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
