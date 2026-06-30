import '@testing-library/jest-dom/vitest';

// ★ REQ-007-v1 (2026-06-30) — HearthSphere 입자 코어 (PARTICLE) 가 추가된
// canvas API 를 호출 (fillRect, setTransform, globalCompositeOperation).
// jsdom 은 HTMLCanvasElement 2D context 를 구현하지 않으므로 minimal
// noop CanvasRenderingContext2D 를 stub. 시각 거동 검증은 픽셀 비교
// 대신 props / data-attribute 로 한다.
if (typeof HTMLCanvasElement !== 'undefined') {
  const noop = () => {};
  const noopReturning = <T,>(v: T) => () => v;
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (kind: string) => unknown;
  };
  if (!('__lucidCanvasStub' in proto)) {
    Object.defineProperty(proto, '__lucidCanvasStub', { value: true });
    proto.getContext = (kind: string) => {
      if (kind !== '2d') return null;
      const gradient = {
        addColorStop: noop,
      };
      return {
        scale: noop,
        setTransform: noop,
        clearRect: noop,
        beginPath: noop,
        arc: noop,
        fill: noop,
        stroke: noop,
        fillRect: noop,
        save: noop,
        restore: noop,
        createRadialGradient: noopReturning(gradient),
        createLinearGradient: noopReturning(gradient),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalCompositeOperation: 'source-over',
        globalAlpha: 1,
      } as unknown as CanvasRenderingContext2D;
    };
  }
}

// ★ HearthSphere 가 의존하는 다른 브라우저 API.
// matchMedia (prefers-reduced-motion 체크). jsdom 미구현.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// rAF / cAF are present on jsdom but they call setTimeout under the hood.
// 컴포넌트는 unmount 시 cancel — 남은 frame 은 noop.
