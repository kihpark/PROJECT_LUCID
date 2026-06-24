import '@testing-library/jest-dom/vitest';

// feat/hearth-oracle-merge — jsdom doesn't implement HTMLCanvasElement
// 2D context. SphereAnimation (home sphere) calls getContext('2d') in a
// useEffect; without a stub the console fills with "Not implemented"
// errors. We provide a minimal noop CanvasRenderingContext2D so the
// component mounts cleanly in tests. The component's visual behaviour
// is verified by inspecting props/data attributes — never by pixel diff.
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
        clearRect: noop,
        beginPath: noop,
        arc: noop,
        fill: noop,
        stroke: noop,
        createRadialGradient: noopReturning(gradient),
        save: noop,
        restore: noop,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
      } as unknown as CanvasRenderingContext2D;
    };
  }
}

// rAF / cAF are present on jsdom but they call setTimeout under the hood.
// We leave the polyfill alone — SphereAnimation cancels on unmount, so
// any leftover frames simply no-op.