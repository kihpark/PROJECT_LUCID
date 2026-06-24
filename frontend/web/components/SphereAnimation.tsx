/**
 * feat/hearth-oracle-merge — Sphere animation (H-2).
 *
 * The HEARTH sphere — the Jarvis-style entry hub for active AI. Renders
 * a particle-ring sphere with four states that the parent can drive:
 *
 *   - idle       (잔잔한 호흡)              — slow gentle breathing
 *   - listening  (입력 시작, 반응)         — wakes up on input focus
 *   - thinking   (검증지식 검색 중, 활발)  — most active during Q&A roundtrip
 *   - speaking   (답변, 리듬)               — rhythmic pulse while answer shown
 *
 * Implementation: Canvas 2D + requestAnimationFrame. Canvas 2D (not Three.js)
 * keeps the bundle small and SSR-safe. The four states map to:
 *   - particleCount   — how many points in the ring (idle 64 → thinking 160)
 *   - rotationSpeed   — base angular velocity (idle 0.15 → thinking 0.75)
 *   - pulseAmplitude  — radius wobble amplitude (idle 0.04 → speaking 0.12)
 *
 * Performance: 60fps target. We cap particle count and gate against
 * `prefers-reduced-motion` (renders a single static frame).
 *
 * Brand: teal/mint (#3fe0c6) is the only accent.
 */
'use client';

import { useEffect, useRef } from 'react';

export type SphereState = 'idle' | 'listening' | 'thinking' | 'speaking';

const ACCENT = '#3fe0c6';

interface SphereAnimationProps {
  state: SphereState;
  /** Size of the canvas in CSS pixels. Square. */
  size?: number;
  /** When true, opt out of all animation (test seam + prefers-reduced-motion
   *  fallback). Renders a single static frame. */
  reducedMotion?: boolean;
}

interface StateParams {
  particleCount: number;
  rotationSpeed: number;
  pulseAmplitude: number;
  pulseFrequency: number;
  glow: number;
}

export const SPHERE_STATE_PARAMS: Record<SphereState, StateParams> = {
  idle: {
    particleCount: 64,
    rotationSpeed: 0.15,
    pulseAmplitude: 0.04,
    pulseFrequency: 0.5,
    glow: 0.5,
  },
  listening: {
    particleCount: 96,
    rotationSpeed: 0.35,
    pulseAmplitude: 0.06,
    pulseFrequency: 1.1,
    glow: 0.7,
  },
  thinking: {
    particleCount: 160,
    rotationSpeed: 0.75,
    pulseAmplitude: 0.08,
    pulseFrequency: 1.6,
    glow: 0.9,
  },
  speaking: {
    particleCount: 128,
    rotationSpeed: 0.5,
    pulseAmplitude: 0.12,
    pulseFrequency: 2.0,
    glow: 1.0,
  },
};

/** Detect `prefers-reduced-motion` — fail-soft on SSR / unsupported. */
function userPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function SphereAnimation({
  state,
  size = 230,
  reducedMotion,
}: SphereAnimationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const stateRef = useRef<SphereState>(state);

  // Keep the live state visible to the animation loop without re-binding
  // the rAF every frame.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced = reducedMotion ?? userPrefersReducedMotion();

    const dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      2, // cap for perf
    );
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const baseRadius = size * 0.27; // core sphere radius
    const ringRadius = size * 0.45; // particle ring radius

    let t0: number | null = null;

    function drawFrame(elapsedMs: number) {
      if (!ctx) return;
      const params = SPHERE_STATE_PARAMS[stateRef.current];
      const t = elapsedMs / 1000;

      ctx.clearRect(0, 0, size, size);

      // ----- Halo glow -----
      const haloR = ringRadius + 14;
      const halo = ctx.createRadialGradient(
        cx,
        cy,
        baseRadius * 0.4,
        cx,
        cy,
        haloR,
      );
      halo.addColorStop(0, `rgba(63,224,198,${0.18 * params.glow})`);
      halo.addColorStop(0.55, `rgba(63,224,198,${0.06 * params.glow})`);
      halo.addColorStop(1, 'rgba(63,224,198,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();

      // ----- Outer ring (stationary, subtle) -----
      ctx.strokeStyle = `rgba(63,224,198,${0.18 + 0.08 * params.glow})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius + 4, 0, Math.PI * 2);
      ctx.stroke();

      // ----- Particle ring (primary) -----
      const pulse =
        1 +
        params.pulseAmplitude *
          Math.sin(t * params.pulseFrequency * Math.PI * 2);
      const rotation = t * params.rotationSpeed * Math.PI * 2;
      const count = params.particleCount;

      for (let i = 0; i < count; i += 1) {
        const phase = (i / count) * Math.PI * 2;
        const angle = phase + rotation;
        const rWobble = 1 + 0.03 * Math.sin(t * 1.7 + phase * 3);
        const r = ringRadius * pulse * rWobble;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r * 0.96;
        const a =
          0.35 +
          0.45 *
            Math.max(0, Math.sin(t * 2 + phase * 2)) *
            params.glow;
        ctx.fillStyle = `rgba(63,224,198,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // ----- Secondary tilted ring (gives the 3D feel) -----
      const secondaryCount = Math.floor(count * 0.6);
      for (let i = 0; i < secondaryCount; i += 1) {
        const phase = (i / secondaryCount) * Math.PI * 2;
        const angle = phase - rotation * 0.7;
        const r = ringRadius * pulse * 0.92;
        const x = cx + Math.cos(angle) * r * 0.85;
        const y = cy + Math.sin(angle) * r * 0.35;
        const a =
          0.18 +
          0.32 *
            Math.max(0, Math.sin(t * 1.4 + phase * 1.6)) *
            params.glow;
        ctx.fillStyle = `rgba(63,224,198,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // ----- Core sphere -----
      const coreGradient = ctx.createRadialGradient(
        cx - baseRadius * 0.3,
        cy - baseRadius * 0.35,
        baseRadius * 0.1,
        cx,
        cy,
        baseRadius,
      );
      coreGradient.addColorStop(0, '#88f0db');
      coreGradient.addColorStop(0.55, ACCENT);
      coreGradient.addColorStop(1, '#04201c');
      ctx.fillStyle = coreGradient;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * pulse, 0, Math.PI * 2);
      ctx.fill();

      // Inner reflection highlight.
      ctx.fillStyle = `rgba(255,255,255,${0.06 + 0.04 * params.glow})`;
      ctx.beginPath();
      ctx.arc(
        cx - baseRadius * 0.25,
        cy - baseRadius * 0.3,
        baseRadius * 0.35,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    if (prefersReduced) {
      // Single static frame — same composition, no rAF loop.
      drawFrame(0);
      return () => {
        /* nothing to clean up */
      };
    }

    function loop(now: number) {
      if (t0 == null) t0 = now;
      drawFrame(now - t0);
      rafRef.current = window.requestAnimationFrame(loop);
    }
    rafRef.current = window.requestAnimationFrame(loop);

    return () => {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, reducedMotion]);

  return (
    <div
      data-testid="home-sphere"
      data-sphere-state={state}
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 36,
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="home-sphere-canvas"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          display: 'block',
        }}
      />
    </div>
  );
}

export default SphereAnimation;
