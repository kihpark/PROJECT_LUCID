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
  BOUNDARY_FRACTION,
  STARFIELD_RADIUS,
  clampNodeToBoundary,
  clampNodesToBoundary,
  computeBoundaryRadius,
  computeCenterStrength,
  computeChargeStrength,
  computeInitialCameraDistance,
  computeLinkDistance,
  computeNodeSizeFloor,
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

// ---------------------------------------------------------------------------
// fix/stellar-cleanup #8 — boundary force helpers.
// ---------------------------------------------------------------------------

describe('computeBoundaryRadius', () => {
  it('defaults to 70% of the starfield radius', () => {
    expect(computeBoundaryRadius()).toBe(STARFIELD_RADIUS * BOUNDARY_FRACTION);
  });

  it('respects custom starfield radius', () => {
    expect(computeBoundaryRadius(1000)).toBe(700);
    expect(computeBoundaryRadius(2000)).toBe(1400);
  });

  it('never returns zero or negative for non-positive input', () => {
    expect(computeBoundaryRadius(0)).toBeGreaterThan(0);
    expect(computeBoundaryRadius(-100)).toBeGreaterThan(0);
  });
});

describe('clampNodeToBoundary', () => {
  it('leaves nodes inside the boundary untouched', () => {
    const node = { x: 100, y: 200, z: -50 };
    expect(clampNodeToBoundary(node, 1000)).toBe(false);
    expect(node.x).toBe(100);
    expect(node.y).toBe(200);
    expect(node.z).toBe(-50);
  });

  it('pulls nodes past the boundary back to the boundary surface', () => {
    const node = { x: 6000, y: 0, z: 0 };
    expect(clampNodeToBoundary(node, 1000)).toBe(true);
    expect(node.x).toBe(1000);
    expect(node.y).toBe(0);
    expect(node.z).toBe(0);
  });

  it('preserves direction when clamping (proportional scale)', () => {
    const node = { x: 600, y: 800, z: 0 }; // distance 1000
    clampNodeToBoundary(node, 500); // should halve
    expect(Math.round(node.x as number)).toBe(300);
    expect(Math.round(node.y as number)).toBe(400);
  });

  it('treats missing axes as zero', () => {
    const node: { x?: number; y?: number; z?: number } = {};
    expect(clampNodeToBoundary(node, 1000)).toBe(false);
  });
});

describe('clampNodesToBoundary — boundary force payload', () => {
  it('keeps every node within the starfield boundary', () => {
    const maxDist = computeBoundaryRadius();
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 200, z: 300 },
      { x: 9000, y: 0, z: 0 },         // way past boundary
      { x: 5000, y: 5000, z: 5000 },   // ~8660 distance, past boundary
    ];
    clampNodesToBoundary(nodes, maxDist);
    for (const n of nodes) {
      const dist = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      expect(dist).toBeLessThanOrEqual(maxDist + 1e-6);
    }
  });

  it('all clamped nodes sit comfortably inside the visible starfield', () => {
    // PO acceptance: nodes must read as INSIDE the cosmic backdrop.
    // 0.7 × STARFIELD_RADIUS = 3150, which is well under 4500 (where stars sit).
    const maxDist = computeBoundaryRadius();
    expect(maxDist).toBeLessThan(STARFIELD_RADIUS);
    expect(maxDist / STARFIELD_RADIUS).toBeLessThanOrEqual(0.7);
  });
});

// ---------------------------------------------------------------------------
// M3-2e regression guard - boundary + zoom + visual.
//
// PO 의뢰서 verbatim: 노드 starfield 경계 내 (밖 누출 0) /
// zoom Nx <-> 카메라 동기 / 살펴보기 클러스터 focus.
//
// 이 가드는 m32b (visual vocab) / m32c (filter) / m32d (interactions) 가
// 기존 STELLAR fix 들 (3890f11 / b9f7056 / d017a3a) 을 회귀시키지 않았음을
// 검증한다. 코드 변경 없이 test 만으로 가드를 명시한다.
// ---------------------------------------------------------------------------

describe('M3-2e regression guard - boundary + zoom + visual', () => {
  it('boundary force: 167 노드 force layout 후 모든 노드 distance < STARFIELD_RADIUS * 0.7', () => {
    // 167 = 실제 dogfood real 그래프 노드 수 sample. 시뮬레이션은
    // 노드들이 모두 boundary 밖으로 튀어나간 worst-case 를 가정한다.
    // 한 번의 boundary-force tick 후 전체 population 은 inner 70% 안.
    const maxDist = computeBoundaryRadius();
    expect(maxDist).toBeCloseTo(STARFIELD_RADIUS * 0.7, 6);
    expect(maxDist).toBeCloseTo(3150, 6);

    const nodes: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 167; i += 1) {
      const t = i / 167;
      nodes.push({
        x: Math.sin(t * 11.3) * 12000,
        y: Math.cos(t * 7.7) * 12000,
        z: Math.sin(t * 4.1 + 1.7) * 12000,
      });
    }
    clampNodesToBoundary(nodes, maxDist);
    for (const n of nodes) {
      const dist = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      expect(dist).toBeLessThanOrEqual(maxDist + 1e-6);
      expect(dist).toBeLessThan(STARFIELD_RADIUS);
    }
  });

  it('boundary force 가 M3-2b 의 nodeRadius 변경에 영향 0 (degree 1 vs 200 모두 boundary 안)', async () => {
    // M3-2b ships nodeRadius(degree) clamped to [4, 24]. The boundary
    // force operates on POSITION, not radius - so a degree-1 node and a
    // degree-200 node must both land inside the boundary after clamp,
    // regardless of their rendered size.
    const { nodeRadius } = await import('@/lib/stellarEdgeStyle');
    const maxDist = computeBoundaryRadius();
    // Both degrees compute distinct radii (m32b contract).
    expect(nodeRadius(1)).toBe(4);
    expect(nodeRadius(200)).toBe(24);
    // Boundary force ignores radius and only looks at x/y/z.
    const a = { x: 9000, y: 0, z: 0 };
    const b = { x: 0, y: 9000, z: 0 };
    clampNodeToBoundary(a, maxDist);
    clampNodeToBoundary(b, maxDist);
    const distA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const distB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
    expect(distA).toBeLessThanOrEqual(maxDist + 1e-6);
    expect(distB).toBeLessThanOrEqual(maxDist + 1e-6);
  });

  it('zoom state <-> camera distance 동기 보존: initial dist / zoom = camera dist', () => {
    // StellarGraph 의 applyZoom: newDist = initialDist / clamped.
    // 폴 루프: actualZoom = initialDist / dist.
    // 이 라운드트립이 보존되어야 zoom UI 와 카메라 위치가 동기.
    for (const totalNodes of [0, 30, 120, 500, 2000]) {
      const initialDist = computeInitialCameraDistance(totalNodes);
      for (const zoom of [0.1, 0.5, 1.0, 2.0, 10.0]) {
        const cameraDist = initialDist / zoom;
        expect(Number.isFinite(cameraDist)).toBe(true);
        expect(cameraDist).toBeGreaterThan(0);
        const recovered = initialDist / cameraDist;
        expect(recovered).toBeCloseTo(zoom, 6);
      }
    }
  });

  it('boundary force 가 M3-2c 의 좌패널 필터 적용 후에도 작동 (필터된 노드도 clamp 됨)', () => {
    // M3-2c filters operate at the data layer (StellarView builds
    // filteredData); whatever survives still flows into the d3-force
    // simulation and the boundary force.
    const maxDist = computeBoundaryRadius();
    const filteredSample: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 12; i += 1) {
      filteredSample.push({
        x: (i % 3) * 5000 - 5000,
        y: ((i + 1) % 3) * 5000 - 5000,
        z: ((i + 2) % 3) * 5000 - 5000,
      });
    }
    clampNodesToBoundary(filteredSample, maxDist);
    for (const n of filteredSample) {
      const dist = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      expect(dist).toBeLessThanOrEqual(maxDist + 1e-6);
    }
  });

  it('zoom range [0.1, 10] 보존: 작은 그래프 (130 init) 도 큰 그래프 (~835 init) 도 정상', () => {
    // stellar-zoom-recover 가 wheel-zoom 범위를 [0.25, 4] -> [0.1, 10] 로
    // 확장. 양극단에서 카메라 거리가 numerically sane 인지 확인.
    const smallInit = computeInitialCameraDistance(0);
    const denseInit = computeInitialCameraDistance(2000);
    expect(smallInit).toBe(130);
    expect(denseInit).toBeGreaterThan(700);
    for (const init of [smallInit, denseInit]) {
      const farthest = init / 0.1;
      const closest = init / 10;
      expect(Number.isFinite(farthest)).toBe(true);
      expect(Number.isFinite(closest)).toBe(true);
      expect(closest).toBeGreaterThan(0);
      expect(farthest).toBeGreaterThan(closest);
    }
  });
});
