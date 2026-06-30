/**
 * REQ-007-v2 — HEARTH Sphere 입자 코어 (PARTICLE / 자비스 계열).
 *
 * v1 → v2 (PO: "작고 허접, 배경 융화 X — wow 실패"):
 *   • 기본 사이즈 230 → 520 (★ 화면 존재감)
 *   • container fill 모드 신설 — `size` 미지정 시 부모 너비의 60% (cap 720)
 *     까지 자동 확대. 홈 페이지에선 ≈ vw 비율로 압도적 존재감.
 *   • 입자 1800 (low-power 800) — 밀도 + 깊이감.
 *   • z 분포 확장 (r 0.55-1.0 → 0.40-1.05) — 앞뒤 깊이 보임.
 *   • bloom 다중 레이어 — outer halo + mid glow + core (★ 배경 자연 융화).
 *   • 배경 fill 제거 (★ v1 의 검은 사각형이 페이지 bg 와 단절). 캔버스
 *     투명 → 페이지 radial gradient 와 사실상 한 화면으로 합쳐짐.
 *   • teal 코어 brightness +30%, 하이라이트 입자 비율 +50%.
 *
 * ★ 4 상태 모델 (변경 0) — "극적 차이" 의 비결은 상태별 파라미터 세트를
 * 매 프레임 부드럽게 lerp 보간하는 것. 단순 if 분기 X.
 *
 *   매 프레임: env[k] += (target[k] - env[k]) * min(1, dt * 0.006)
 *   → 약 0.006/ms 속도로 타깃 수렴 (~0.3-0.5s 전환).
 *
 * ★ 상태 의도 (v1 ↔ v2 contract 동일):
 *   - idle      대기  : 미세 호흡 + 저속 회전
 *   - listening 경청  : 마우스 끌림 (pull 1.0) + 수축 (contract)
 *   - thinking  사고  : ★ 가장 역동적 — 고속 회전 + 강한 난류
 *   - speaking  응답  : 음성 파형 맥동 (wave 1.0 + breathe 0.15)
 *
 * ★ 살아있음 (auto-drift 항상 가산 — 마우스 없어도 안 죽음):
 *   auto.x = sin(t * 0.00042) * 0.18
 *   auto.y = cos(t * 0.00051) * 0.12
 *
 * ★ 성능 — 60fps 목표 (v2 더 큰 캔버스 대비 보정):
 *   - DPR 캡 1.5 (1.6→1.5 — 큰 캔버스에서 픽셀 부하 통제)
 *   - 저사양 폴백 (hardwareConcurrency <= 4 → 입자 800)
 *   - dt 상한 50ms (탭 비활성 복귀 시 점프 방지)
 *   - 입자는 fillRect (1~2.5px) — arc 보다 빠름
 *   - 탭 비활성 시 rAF 정지 (배터리)
 *
 * ★ Backwards compat: 기존 SphereAnimation 의 wrapper 테스트 셈 (testid
 * home-sphere, data-sphere-state) + REQ-007-v1 의 hearth-sphere-canvas
 * testid + HEARTH_TARGET_PARAMS contract 모두 유지.
 */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type HearthSphereState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface HearthSphereProps {
  state: HearthSphereState;
  /** Canvas size (square) in CSS px. ★ v2: 미지정 시 부모 너비 기반 자동
   *  계산 (60% cap 720). 명시 시 그 값을 그대로 사용 (테스트 / 고정
   *  레이아웃 호환). */
  size?: number;
  /** Opt-out for `prefers-reduced-motion` and test harnesses. Renders a
   * single static frame instead of starting rAF. */
  reducedMotion?: boolean;
}

/** ★ 상태별 타깃 파라미터 — 핸드오프 verbatim. v2 contract 동일. */
interface StateParams {
  spin: number;
  breathe: number;
  turb: number;
  pull: number;
  wave: number;
  contract: number;
  bright: number;
}

export const HEARTH_TARGET_PARAMS: Record<HearthSphereState, StateParams> = {
  idle:      { spin: 0.18, breathe: 0.05, turb: 0.05, pull: 0.14, wave: 0,   contract: 0.0,   bright: 0.85 },
  listening: { spin: 0.12, breathe: 0.03, turb: 0.03, pull: 1.0,  wave: 0,   contract: 0.22,  bright: 1.0  },
  thinking:  { spin: 1.35, breathe: 0.04, turb: 1.0,  pull: 0.28, wave: 0,   contract: -0.05, bright: 1.18 },
  speaking:  { spin: 0.38, breathe: 0.15, turb: 0.13, pull: 0.26, wave: 1.0, contract: 0.0,   bright: 1.22 },
};

interface Particle {
  /** 구면좌표 — θ 경도 */
  th: number;
  /** 구면좌표 — φ 위도 */
  ph: number;
  /** 반지름 (중심 쏠림 0.40~1.05 — v2: 깊이 확장) */
  r: number;
  /** 크기/색 결정 */
  sz: number;
  /** 개별 속도 */
  sp: number;
  /** 위상 (shimmer 다양화) */
  ph2: number;
}

/** ★ v2 — container fill 기본 크기 계산. PO "화면의 40-60%" 의뢰.
 *   - 부모 너비 × 0.6 (cap 720, floor 320)
 *   - SSR / 부모 측정 실패 → 480 (v1 230 보다 큰 안전 기본). */
function computeAutoSize(parentWidth: number | null): number {
  if (!parentWidth || parentWidth <= 0) return 480;
  const target = parentWidth * 0.6;
  return Math.max(320, Math.min(720, Math.round(target)));
}

/** Detect `prefers-reduced-motion` — fail-soft on SSR / unsupported. */
function userPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** ★ 입자 균등 구면 분포 — phi = acos(2u - 1), theta = 2π · v.
 *  v2: 반경 분포 0.40-1.05 (v1 0.55-1.0) — 안쪽 핵 + 바깥 헤일로 입자. */
function createParticles(count: number): Particle[] {
  const arr: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random();
    arr.push({
      th: 2 * Math.PI * u,
      ph: Math.acos(2 * v - 1),
      // ★ v2 중심 쏠림 + 바깥 halo: 0.40 base + sqrt(0~1) * 0.65
      r: 0.40 + Math.pow(Math.random(), 0.55) * 0.65,
      sz: Math.random(),
      sp: 0.5 + Math.random() * 1.1,
      ph2: Math.random() * 6.283,
    });
  }
  return arr;
}

export function HearthSphere({
  state,
  size,
  reducedMotion,
}: HearthSphereProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const stateRef = useRef<HearthSphereState>(state);

  // ★ v2 — container fill: 부모 너비를 측정 → autoSize 계산.
  // size prop 가 명시되면 그 값을 그대로 사용 (테스트 / 고정 레이아웃 호환).
  const [autoSize, setAutoSize] = useState<number>(() => computeAutoSize(null));
  useLayoutEffect(() => {
    if (size != null) return; // 명시 size → 측정 불필요
    const el = wrapperRef.current?.parentElement;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      setAutoSize(computeAutoSize(w));
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    // 폴백: window resize
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [size]);

  const effectiveSize = size ?? autoSize;

  // ★ state 변경 시 ref 만 갱신 — rAF 재시작 0 (시각 끊김 0).
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced = reducedMotion ?? userPrefersReducedMotion();

    // ★ DPR 캡 1.5 — v2 큰 캔버스에서 픽셀 부하 통제.
    const dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      1.5,
    );
    canvas.width = Math.round(effectiveSize * dpr);
    canvas.height = Math.round(effectiveSize * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ★ v2 입자 밀도: 1800 (low-power 800). v1 920/460 보다 +95% / +74%.
    const lowPower =
      typeof navigator !== 'undefined' &&
      (navigator.hardwareConcurrency ?? 8) <= 4;
    const particleCount = lowPower ? 800 : 1800;
    const particles = createParticles(particleCount);

    // ★ env = 매 프레임 lerp 된 현재 파라미터. 초기값 = idle.
    const env: StateParams = { ...HEARTH_TARGET_PARAMS.idle };

    // ★ 마우스 포인터 (정규화 -1..1, 보간 후 사용).
    const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
    // ★ auto-drift — 마우스 없을 때도 살아있음.
    const auto = { x: 0, y: 0 };
    let rot = 0;
    let voice = 0;
    let last: number | null = null;

    // 마우스 추적 — 정규화 + pointerleave 시 0 복귀.
    const onPointerMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ptr.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    const onPointerLeave = () => {
      ptr.tx = 0;
      ptr.ty = 0;
    };
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    /** ★ v2 — 배경 fill 제거 (검은 사각형 → 페이지 bg 와 단절 원인).
     *   대신 transparent clear → 페이지 radial gradient backdrop 가
     *   캔버스 너머까지 자연 확장 → 코어와 한 화면으로 융화. */
    function clearTransparent(w: number, h: number) {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
    }

    function drawFrame(now: number) {
      if (!ctx) return;
      const w = effectiveSize;
      const h = effectiveSize;
      const cx = w / 2;
      const cy = h * 0.5;  // v2: 중앙 정렬 (v1 0.46 → 약간 위쪽 비대칭 제거)
      const R = Math.min(w, h) * 0.32;  // v2: 0.30 → 0.32 (코어 약간 확대)

      clearTransparent(w, h);

      const p = ptr;
      const e = env;
      const t = now;
      const focal = R * 3.4;

      // ★ 마우스 + auto-drift 합성 → 회전축 기울기.
      const ty = p.x * 0.6 + auto.x;
      const tx = p.y * 0.5 + auto.y;
      const cosY = Math.cos(rot + ty);
      const sinY = Math.sin(rot + ty);
      const cosX = Math.cos(tx);
      const sinX = Math.sin(tx);

      // ★ 음성 파형 맥동 (speaking).
      const voicePulse = 1 + e.breathe * voice * 1.1;
      // ★ 수축 (listening).
      const contract = 1 - e.contract * 0.7;
      // ★ 마우스 끌림 (listening 시 최대).
      const leanX = p.x * R * 0.7 * e.pull;
      const leanY = p.y * R * 0.55 * e.pull;

      ctx.globalCompositeOperation = 'lighter';

      // ★★★ v2 LAYER 1 — Outer Halo (★ 가장 큰 변화: 캔버스 가장자리까지
      //  발광 → 배경에 융화). 매우 넓은 falloff, 낮은 alpha.
      const halo = ctx.createRadialGradient(
        cx, cy, R * 0.6,
        cx, cy, Math.min(w, h) * 0.55,
      );
      halo.addColorStop(0,    `rgba(45,212,191,${0.18 * e.bright})`);
      halo.addColorStop(0.45, `rgba(35,180,170,${0.07 * e.bright})`);
      halo.addColorStop(1,    'rgba(8,40,38,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      // ★★★ v2 LAYER 2 — Mid Glow (코어 주변 청록색 안개).
      const mid = ctx.createRadialGradient(
        cx + leanX * 0.4, cy + leanY * 0.4, 0,
        cx + leanX * 0.4, cy + leanY * 0.4, R * 1.8,
      );
      mid.addColorStop(0,    `rgba(60,230,210,${0.32 * e.bright})`);
      mid.addColorStop(0.40, `rgba(33,170,160,${0.14 * e.bright})`);
      mid.addColorStop(1,    'rgba(8,40,38,0)');
      ctx.fillStyle = mid;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.8, 0, 6.2832);
      ctx.fill();

      // ★★★ v2 LAYER 3 — Inner Core (★ teal 발광 코어 — PO 직접 의뢰).
      const core = ctx.createRadialGradient(
        cx + leanX * 0.4, cy + leanY * 0.4, 0,
        cx + leanX * 0.4, cy + leanY * 0.4, R * 0.85,
      );
      core.addColorStop(0,    `rgba(180,255,240,${0.42 * e.bright})`);
      core.addColorStop(0.30, `rgba(80,235,215,${0.28 * e.bright})`);
      core.addColorStop(0.70, `rgba(45,200,185,${0.12 * e.bright})`);
      core.addColorStop(1,    'rgba(8,40,38,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.85, 0, 6.2832);
      ctx.fill();

      // ★ 입자 — 구면 → 3D → 회전 → 원근 투영. (v2 contract 동일)
      const swirl = e.turb;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]!;

        // ★ 난류 (thinking 시 격렬한 소용돌이).
        const thLocal = a.th + rot + swirl * 1.6 * Math.sin(t * 0.0012 * a.sp + a.ph2);
        const phLocal = a.ph + swirl * 0.7 * Math.sin(t * 0.0015 * a.sp + a.ph2 * 1.6);

        // ★ 반경 = base × contract × voicePulse.
        const r = a.r * R * contract * voicePulse;

        // 구면 → 데카르트.
        const sinPh = Math.sin(phLocal);
        const x0 = r * sinPh * Math.cos(thLocal);
        const y0 = r * Math.cos(phLocal);
        const z0 = r * sinPh * Math.sin(thLocal);

        // Y 회전 (yaw) → X 회전 (pitch).
        const x1 = x0 * cosY + z0 * sinY;
        const z1 = -x0 * sinY + z0 * cosY;
        const y2 = y0 * cosX - z1 * sinX;
        const z2 = y0 * sinX + z1 * cosX;

        // 원근 투영.
        const persp = focal / (focal - z2);

        // 깊이 (0~1, 앞쪽이 큼). v2: 더 넓은 r 분포에 맞춰 정규화 조정.
        const depth = Math.max(0, Math.min(1, (z2 / R + 1.5) / 2.6));

        // ★ 화면공간 lean — 입자 구름이 커서 쪽으로 쏠림.
        const sx = cx + x1 * persp + leanX * (0.5 + depth * 0.7);
        const sy = cy + y2 * persp + leanY * (0.5 + depth * 0.7);

        // v2: 입자 크기 ↑ (큰 캔버스에서 가독성).
        const sizePx = (0.7 + 2.2 * depth) * (0.6 + a.sz);
        const shimmer = 0.6 + 0.4 * Math.sin(t * 0.004 * a.sp + a.ph2);
        const al = depth * depth * e.bright * shimmer;

        // ★ v2 — 하이라이트 입자 임계 0.86 → 0.78 (★ 밝은 점 +50%).
        if (a.sz > 0.78) {
          ctx.fillStyle = `rgba(180,255,240,${al})`;
        } else {
          ctx.fillStyle = `rgba(60,220,200,${al * 0.88})`;
        }
        // ★ fillRect 가 arc 보다 빠름 — 1800 입자 × 60fps 부하 통제.
        ctx.fillRect(sx - sizePx / 2, sy - sizePx / 2, sizePx, sizePx);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function step(now: number) {
      if (last == null) last = now;
      let dt = now - last;
      last = now;
      // ★ dt 상한 50ms — 탭 비활성 복귀 시 점프 방지.
      if (dt > 50) dt = 50;
      const t = now;

      // ★ ★ ★ 매 프레임 lerp — "극적 차이" 의 비결.
      const tgt = HEARTH_TARGET_PARAMS[stateRef.current];
      const ls = Math.min(1, dt * 0.006);
      (Object.keys(tgt) as Array<keyof StateParams>).forEach((k) => {
        env[k] += (tgt[k] - env[k]) * ls;
      });

      // 마우스 보간 (부드러움).
      const ps = Math.min(1, dt * 0.009);
      ptr.x += (ptr.tx - ptr.x) * ps;
      ptr.y += (ptr.ty - ptr.y) * ps;

      // 회전 누적.
      rot += env.spin * dt * 0.0017;

      // ★ auto-drift — 마우스 없을 때도 회전축 기울기 변동.
      auto.x = Math.sin(t * 0.00042) * 0.18;
      auto.y = Math.cos(t * 0.00051) * 0.12;

      // ★ 음성 파형 — 다중 사인 합성 (-1..1).
      voice =
        Math.sin(t * 0.011) * 0.6 +
        Math.sin(t * 0.019 + 1) * 0.3 +
        Math.sin(t * 0.031 + 2) * 0.22;

      drawFrame(t);

      if (!stopped) {
        rafRef.current = window.requestAnimationFrame(step);
      }
    }

    let stopped = false;

    if (prefersReduced) {
      // 단일 정적 프레임 — 레이아웃 유지, 모션 0.
      drawFrame(0);
      return () => {
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerleave', onPointerLeave);
      };
    }

    // ★ 탭 비활성 시 정지 (배터리).
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        if (stopped) {
          stopped = false;
          last = null;
          rafRef.current = window.requestAnimationFrame(step);
        }
      } else {
        stopped = true;
        if (rafRef.current != null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    rafRef.current = window.requestAnimationFrame(step);

    return () => {
      stopped = true;
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSize, reducedMotion]);

  return (
    <div
      ref={wrapperRef}
      // ★ Backwards compat — 기존 단위 테스트 (HomePage.test, SphereAnimation.test)
      // 가 home-sphere / data-sphere-state 를 pin 하므로 유지.
      data-testid="home-sphere"
      data-sphere-state={state}
      data-hearth-sphere="particle-core"
      data-hearth-version="v2"
      style={{
        position: 'relative',
        width: effectiveSize,
        height: effectiveSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // v2: 큰 캔버스 ↔ 다음 요소 (BrandLine) 간격 축소 (시각 응집).
        marginBottom: 16,
      }}
    >
      <canvas
        ref={canvasRef}
        // ★ REQ-007 의뢰서 — Playwright e2e 가 pin 하는 testid (유지).
        data-testid="hearth-sphere-canvas"
        data-state={state}
        aria-hidden="true"
        style={{
          width: effectiveSize,
          height: effectiveSize,
          display: 'block',
          // ★ "살아있음" 체감 — 커서 위에서 코어가 반응.
          cursor: 'crosshair',
        }}
      />
    </div>
  );
}

export default HearthSphere;
