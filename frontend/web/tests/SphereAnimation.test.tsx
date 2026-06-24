/**
 * feat/hearth-oracle-merge — SphereAnimation (H-2) tests.
 *
 * Jsdom doesn't implement WebGL; we don't render the canvas pixels. The
 * tests verify:
 *   - state prop is reflected on the wrapper (data-sphere-state),
 *   - all four states render without crashing (idle / listening / thinking
 *     / speaking),
 *   - requestAnimationFrame is invoked on mount (animation loop scheduled),
 *   - rAF is NOT invoked when reducedMotion is true (single static frame),
 *   - the canvas itself mounts and is aria-hidden.
 *
 * The setup.ts file installs a noop CanvasRenderingContext2D so the
 * useEffect that grabs the 2D context succeeds in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  SphereAnimation,
  SPHERE_STATE_PARAMS,
  type SphereState,
} from '@/components/SphereAnimation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rafSpy: any = null;

beforeEach(() => {
  rafSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((cb: FrameRequestCallback): number => {
      // Run the first frame synchronously so drawFrame fires once, but
      // return a stable handle so cancelAnimationFrame can pretend.
      try {
        cb(0);
      } catch {
        /* canvas calls in jsdom are no-ops; ignore */
      }
      return 1;
    });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  rafSpy?.mockRestore();
  rafSpy = null;
  cleanup();
});

describe('SphereAnimation', () => {
  it('renders a canvas + wrapper with the state on data-sphere-state', () => {
    render(<SphereAnimation state="idle" />);
    const wrapper = screen.getByTestId('home-sphere');
    expect(wrapper).toBeInTheDocument();
    expect(wrapper.getAttribute('data-sphere-state')).toBe('idle');
    const canvas = screen.getByTestId('home-sphere-canvas');
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('all four states mount cleanly (idle / listening / thinking / speaking)', () => {
    const states: SphereState[] = ['idle', 'listening', 'thinking', 'speaking'];
    for (const s of states) {
      cleanup();
      render(<SphereAnimation state={s} />);
      const wrapper = screen.getByTestId('home-sphere');
      expect(wrapper.getAttribute('data-sphere-state')).toBe(s);
    }
  });

  it('requestAnimationFrame is scheduled on mount (animation loop active)', () => {
    render(<SphereAnimation state="thinking" />);
    expect(rafSpy).toHaveBeenCalled();
  });

  it('reducedMotion=true skips the rAF loop (static fallback)', () => {
    rafSpy?.mockClear();
    render(<SphereAnimation state="thinking" reducedMotion />);
    expect(rafSpy).not.toHaveBeenCalled();
    // Wrapper still mounts so layout doesn't shift.
    expect(screen.getByTestId('home-sphere')).toBeInTheDocument();
  });

  it('state-param table: thinking has the most particles, idle the fewest', () => {
    // Sanity contract — the visual loudness ordering should be:
    //   idle < listening < speaking ≤ thinking
    // We just pin idle < thinking here so an accidental swap (idle = 160)
    // trips the suite.
    expect(SPHERE_STATE_PARAMS.idle.particleCount).toBeLessThan(
      SPHERE_STATE_PARAMS.thinking.particleCount,
    );
    expect(SPHERE_STATE_PARAMS.idle.rotationSpeed).toBeLessThan(
      SPHERE_STATE_PARAMS.thinking.rotationSpeed,
    );
    // Speaking has the largest pulse amplitude (the "rhythmic" delivery).
    expect(SPHERE_STATE_PARAMS.speaking.pulseAmplitude).toBeGreaterThanOrEqual(
      SPHERE_STATE_PARAMS.thinking.pulseAmplitude,
    );
  });
});
