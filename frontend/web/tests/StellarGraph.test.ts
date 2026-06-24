/**
 * feat/stellar-camera-focus — density-aware layout helpers.
 *
 * The Stellar renderer itself can't be unit-tested (jsdom has no WebGL),
 * so we exercise the pure functions that drive its force-tuning and
 * size-scaling instead. PO's complaint: with a handful of facts the nodes
 * scatter across the universe sphere as tiny dots, making left-click
 * rotation a frustrating hunt-and-peck. These helpers encode the policy
 * that fixes that.
 *
 * Note: the file extension is `.ts` (not `.tsx`) because none of these
 * helpers touch JSX — they are arithmetic over `totalNodes`.
 */
import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  computeCenterStrength,
  computeChargeStrength,
  computeInitialCameraDistance,
  computeLinkDistance,
  computeNodeSizeFloor,
  formatZoomLabel,
} from '@/components/StellarGraph';

describe('computeChargeStrength', () => {
  it('returns weak repulsion for small graphs so nodes huddle inward', () => {
    expect(computeChargeStrength(0)).toBe(-50);
    expect(computeChargeStrength(5)).toBe(-50);
    expect(computeChargeStrength(29)).toBe(-50);
  });

  it('keeps the dense-mode default of -150 once the graph is busy', () => {
    expect(computeChargeStrength(120)).toBe(-150);
    expect(computeChargeStrength(500)).toBe(-150);
    expect(computeChargeStrength(2000)).toBe(-150);
  });

  it('ramps monotonically between the small/dense regimes (no NaN)', () => {
    const mid = computeChargeStrength(75);
    expect(mid).toBeLessThan(-50);
    expect(mid).toBeGreaterThan(-150);
    expect(Number.isFinite(mid)).toBe(true);
  });
});

describe('computeLinkDistance', () => {
  it('shortens link distance for small graphs (pull neighbours closer)', () => {
    expect(computeLinkDistance(0)).toBe(12);
    expect(computeLinkDistance(10)).toBe(12);
    expect(computeLinkDistance(29)).toBe(12);
  });

  it('keeps the dense-mode default of 18 for busy graphs', () => {
    expect(computeLinkDistance(120)).toBe(18);
    expect(computeLinkDistance(2000)).toBe(18);
  });

  it('ramps within the [12, 18] band on the in-between range', () => {
    const mid = computeLinkDistance(60);
    expect(mid).toBeGreaterThanOrEqual(12);
    expect(mid).toBeLessThanOrEqual(18);
  });
});

describe('computeCenterStrength', () => {
  it('applies a noticeable inward tug for small graphs', () => {
    // PO repro is "few facts scattered across the universe sphere".
    // A positive center strength is the explicit "pull them home" signal.
    expect(computeCenterStrength(5)).toBeGreaterThan(0);
    expect(computeCenterStrength(20)).toBeGreaterThan(0);
  });

  it('returns 0 once cluster structure should dominate', () => {
    expect(computeCenterStrength(60)).toBe(0);
    expect(computeCenterStrength(120)).toBe(0);
    expect(computeCenterStrength(2000)).toBe(0);
  });

  it('tapers smoothly between the small and dense regimes', () => {
    const small = computeCenterStrength(30);
    const middle = computeCenterStrength(45);
    expect(small).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThanOrEqual(0);
  });
});

describe('computeNodeSizeFloor', () => {
  it('gives small graphs an oversized floor so each disc is targetable', () => {
    // Reference points pinned by the helper's contract.
    expect(computeNodeSizeFloor(1)).toBe(5.0);
    expect(computeNodeSizeFloor(10)).toBe(5.0);
  });

  it('falls back to the established 2.0 floor for dense graphs', () => {
    expect(computeNodeSizeFloor(100)).toBe(2.0);
    expect(computeNodeSizeFloor(300)).toBe(2.0);
    expect(computeNodeSizeFloor(2000)).toBe(2.0);
  });

  it('shrinks monotonically across the in-between range', () => {
    const a = computeNodeSizeFloor(20);
    const b = computeNodeSizeFloor(40);
    const c = computeNodeSizeFloor(80);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('never returns a negative or NaN value', () => {
    for (const n of [0, 1, 5, 25, 100, 500, 5000]) {
      const v = computeNodeSizeFloor(n);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('feat/stellar-zoom-sync — unified zoom contract', () => {
  it('exposes finite ZOOM_MIN / ZOOM_MAX with MIN < 1 < MAX', () => {
    // The "1.00x" rest position must sit strictly inside the clamp band;
    // otherwise the +/- buttons would arrive disabled on first paint.
    expect(Number.isFinite(ZOOM_MIN)).toBe(true);
    expect(Number.isFinite(ZOOM_MAX)).toBe(true);
    expect(ZOOM_MIN).toBeLessThan(1);
    expect(ZOOM_MAX).toBeGreaterThan(1);
  });

  it('clampZoom holds in-band values unchanged', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.5)).toBe(0.5);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX);
  });

  it('clampZoom rejects the PO-repro 100x wheel overshoot', () => {
    // PO live evidence: mouse wheel was driving the readout past 100x while
    // the camera was visually frozen. The unified clamp must catch that
    // before it reaches the readout, regardless of which path computed it.
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(9999)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(-50)).toBe(ZOOM_MIN);
  });

  it('clampZoom returns 1.0 for non-finite input (defensive)', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('formatZoomLabel uses the same clamp as the underlying state', () => {
    // The readout cannot show a value that the +/- buttons can't reach;
    // wheel-driven and button-driven zoom share this string formula.
    expect(formatZoomLabel(1)).toBe('1.00x');
    expect(formatZoomLabel(2.5)).toBe('2.50x');
    expect(formatZoomLabel(100)).toBe(`${ZOOM_MAX.toFixed(2)}x`);
    expect(formatZoomLabel(0)).toBe(`${ZOOM_MIN.toFixed(2)}x`);
  });
});

describe('computeInitialCameraDistance', () => {
  it('returns a finite, positive distance for cold-start and dense cases', () => {
    expect(computeInitialCameraDistance(0)).toBeGreaterThan(0);
    expect(Number.isFinite(computeInitialCameraDistance(2000))).toBe(true);
  });

  it('floors at 130 for sparse graphs so the first frame is not "tiny dots far away"', () => {
    expect(computeInitialCameraDistance(0)).toBe(130);
    expect(computeInitialCameraDistance(5)).toBe(130);
  });

  it('ramps up substantially for the dense synthetic galaxy and caps at 900', () => {
    // 30 + 18 * sqrt(2000) ≈ 835, well above the sparse-graph floor and
    // comfortably under the 900 ceiling.
    expect(computeInitialCameraDistance(2000)).toBeGreaterThan(700);
    // Extreme sizes saturate at the 900 ceiling — the camera doesn't run
    // off into the starfield.
    expect(computeInitialCameraDistance(100000)).toBe(900);
  });
});
