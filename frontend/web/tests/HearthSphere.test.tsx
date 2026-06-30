/**
 * ★ REQ-007-v1 (2026-06-30) — HearthSphere 입자 코어 단위 테스트.
 *
 * jsdom 은 WebGL 미구현 — pixel diff 0. 다음 contract 만 검증:
 *   - state prop 이 wrapper 의 data-sphere-state + canvas 의 data-state
 *     에 반영 (backwards compat: 기존 home-sphere testid 유지)
 *   - 4 상태 (idle / listening / thinking / speaking) 모두 mount 안전
 *   - requestAnimationFrame 이 mount 시 호출 (애니메이션 loop 활성)
 *   - reducedMotion=true 시 rAF 미호출 (정적 fallback)
 *   - HEARTH_TARGET_PARAMS 의 contract — idle ↔ thinking 가 ★ 극적으로
 *     다르다 (PO Acceptance 1).
 *
 * setup.ts 가 canvas 2D context 와 matchMedia 를 stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  HearthSphere,
  HEARTH_TARGET_PARAMS,
  type HearthSphereState,
} from '@/components/HearthSphere';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rafSpy: any = null;

beforeEach(() => {
  rafSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((cb: FrameRequestCallback): number => {
      // 첫 frame 만 동기 실행 → drawFrame 한 번 발화. 스케줄링 무한루프 방지.
      try {
        cb(0);
      } catch {
        /* jsdom canvas calls are no-ops; ignore */
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

describe('HearthSphere — 입자 코어 (REQ-007-v1)', () => {
  it('canvas + wrapper 가 state 를 data-attribute 로 노출 (backwards compat)', () => {
    render(<HearthSphere state="idle" />);
    const wrapper = screen.getByTestId('home-sphere');
    expect(wrapper).toBeInTheDocument();
    expect(wrapper.getAttribute('data-sphere-state')).toBe('idle');
    expect(wrapper.getAttribute('data-hearth-sphere')).toBe('particle-core');
    const canvas = screen.getByTestId('hearth-sphere-canvas');
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.getAttribute('data-state')).toBe('idle');
  });

  it('4 상태 (idle / listening / thinking / speaking) 모두 mount 안전', () => {
    const states: HearthSphereState[] = ['idle', 'listening', 'thinking', 'speaking'];
    for (const s of states) {
      cleanup();
      render(<HearthSphere state={s} />);
      const wrapper = screen.getByTestId('home-sphere');
      expect(wrapper.getAttribute('data-sphere-state')).toBe(s);
      const canvas = screen.getByTestId('hearth-sphere-canvas');
      expect(canvas.getAttribute('data-state')).toBe(s);
    }
  });

  it('mount 시 requestAnimationFrame 스케줄 (rAF loop 활성)', () => {
    render(<HearthSphere state="thinking" />);
    expect(rafSpy).toHaveBeenCalled();
  });

  it('reducedMotion=true → rAF 미스케줄 (정적 fallback)', () => {
    rafSpy?.mockClear();
    render(<HearthSphere state="thinking" reducedMotion />);
    expect(rafSpy).not.toHaveBeenCalled();
    // wrapper 는 여전히 mount — 레이아웃 shift 0.
    expect(screen.getByTestId('home-sphere')).toBeInTheDocument();
  });

  describe('HEARTH_TARGET_PARAMS — ★ 4 상태 극적 차이 (PO Acceptance 1)', () => {
    it('thinking 의 spin 이 idle 보다 크게 (★ 가장 역동)', () => {
      expect(HEARTH_TARGET_PARAMS.thinking.spin).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.idle.spin,
      );
      // ★ 핸드오프 verbatim: idle 0.18 → thinking 1.35 (7배).
      expect(HEARTH_TARGET_PARAMS.thinking.spin).toBeGreaterThanOrEqual(1.3);
      expect(HEARTH_TARGET_PARAMS.idle.spin).toBeLessThanOrEqual(0.2);
    });

    it('thinking 의 turb 가 다른 상태보다 크게 (★ 강한 난류)', () => {
      expect(HEARTH_TARGET_PARAMS.thinking.turb).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.idle.turb,
      );
      expect(HEARTH_TARGET_PARAMS.thinking.turb).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.listening.turb,
      );
      expect(HEARTH_TARGET_PARAMS.thinking.turb).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.speaking.turb,
      );
    });

    it('listening 의 pull 이 최대 (★ 마우스 끌림)', () => {
      expect(HEARTH_TARGET_PARAMS.listening.pull).toBeGreaterThanOrEqual(1.0);
      expect(HEARTH_TARGET_PARAMS.listening.pull).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.idle.pull,
      );
    });

    it('speaking 의 wave 만 활성 (★ 음성 파형)', () => {
      expect(HEARTH_TARGET_PARAMS.speaking.wave).toBeGreaterThanOrEqual(1.0);
      expect(HEARTH_TARGET_PARAMS.idle.wave).toBe(0);
      expect(HEARTH_TARGET_PARAMS.listening.wave).toBe(0);
      expect(HEARTH_TARGET_PARAMS.thinking.wave).toBe(0);
    });

    it('speaking 의 breathe 가 가장 큼 (★ 리듬감)', () => {
      expect(HEARTH_TARGET_PARAMS.speaking.breathe).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.idle.breathe,
      );
      expect(HEARTH_TARGET_PARAMS.speaking.breathe).toBeGreaterThan(
        HEARTH_TARGET_PARAMS.thinking.breathe,
      );
    });

    it('listening 의 contract 가 양수 (★ 안으로 빨려듦)', () => {
      expect(HEARTH_TARGET_PARAMS.listening.contract).toBeGreaterThan(0);
    });
  });
});
