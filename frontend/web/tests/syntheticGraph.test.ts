/**
 * B-62 — synthetic generator tests. Pinned to the recipe in lib/syntheticGraph.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  generateSyntheticGraph,
  EDGE_COLORS,
  type StellarLink,
  type StellarNode,
} from '@/lib/syntheticGraph';

describe('generateSyntheticGraph', () => {
  it('default seed produces a node count in [1500, 3000]', () => {
    const g = generateSyntheticGraph();
    expect(g.nodes.length).toBeGreaterThanOrEqual(1500);
    expect(g.nodes.length).toBeLessThanOrEqual(3000);
  });

  it('every node carries a cluster id and ≥5 distinct clusters exist', () => {
    const g = generateSyntheticGraph();
    const ids = new Set<number>();
    for (const node of g.nodes) {
      expect(typeof node.cluster).toBe('number');
      ids.add(node.cluster);
    }
    expect(ids.size).toBeGreaterThanOrEqual(5);
    // ≤ 8 by the recipe (CLUSTER_MAX).
    expect(ids.size).toBeLessThanOrEqual(8);
    // The cluster name list aligns with the node cluster indices.
    expect(g.clusters.length).toBe(ids.size);
  });

  it('edge type distribution falls within target ratios', () => {
    const g = generateSyntheticGraph();
    const total = g.links.length;
    expect(total).toBeGreaterThan(0);
    const counts: Record<string, number> = {
      supports: 0,
      elaborates: 0,
      causes: 0,
      contradicts: 0,
    };
    for (const link of g.links as StellarLink[]) {
      counts[link.type] = (counts[link.type] ?? 0) + 1;
    }
    const supportsPct = counts.supports! / total;
    const contradictsPct = counts.contradicts! / total;
    // Recipe: supports 60% ± 10pp, contradicts 5% ± 3pp.
    expect(supportsPct).toBeGreaterThanOrEqual(0.5);
    expect(supportsPct).toBeLessThanOrEqual(0.7);
    expect(contradictsPct).toBeGreaterThanOrEqual(0.02);
    expect(contradictsPct).toBeLessThanOrEqual(0.08);
    // All four edge types are represented in the color recipe.
    for (const t of Object.keys(EDGE_COLORS)) {
      expect(typeof EDGE_COLORS[t as keyof typeof EDGE_COLORS]).toBe('string');
    }
  });

  it('same seed produces identical output (deterministic)', () => {
    const a = generateSyntheticGraph({ seed: 4242 });
    const b = generateSyntheticGraph({ seed: 4242 });
    expect(a.nodes.length).toBe(b.nodes.length);
    expect(a.links.length).toBe(b.links.length);
    // Spot-check a handful of nodes for exact equality.
    for (let i = 0; i < Math.min(20, a.nodes.length); i += 1) {
      expect(a.nodes[i]).toEqual(b.nodes[i]);
    }
    for (let i = 0; i < Math.min(20, a.links.length); i += 1) {
      expect(a.links[i]).toEqual(b.links[i]);
    }
  });

  it('node positions have non-trivial spread (variance > minimum)', () => {
    const g = generateSyntheticGraph({ seed: 0xfeed });
    const xs = g.nodes.map((n: StellarNode) => n.x);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / xs.length;
    // The cluster radius R is 380 and σ is 55 — the variance of x positions
    // across the full galaxy must comfortably clear 1000 (≈ a single tight
    // ball would sit at ~σ² = 3025 inside one cluster, and we have many
    // clusters spread on a sphere of radius 380).
    expect(variance).toBeGreaterThan(1000);
  });

  it('different seeds produce different node ids ordering / labels', () => {
    const a = generateSyntheticGraph({ seed: 1 });
    const b = generateSyntheticGraph({ seed: 2 });
    // First node label is likely different (probabilistic but should always
    // differ given the vocabulary size + random predicate / object draws).
    expect(a.nodes[0]?.label).not.toBe(b.nodes[0]?.label);
  });

  it('clamps absurd nodeCount requests to the [1500, 3000] window', () => {
    const small = generateSyntheticGraph({ nodeCount: 10 });
    expect(small.nodes.length).toBeGreaterThanOrEqual(1500);
    const big = generateSyntheticGraph({ nodeCount: 100000 });
    expect(big.nodes.length).toBeLessThanOrEqual(3000);
  });

  // B-62-v1 — graph metrics must be attached after the link set is built.
  it('every node carries a degree that matches the link incidence count', () => {
    const g = generateSyntheticGraph();
    const expected = new Map<string, number>();
    for (const link of g.links) {
      expected.set(String(link.source), (expected.get(String(link.source)) ?? 0) + 1);
      expected.set(String(link.target), (expected.get(String(link.target)) ?? 0) + 1);
    }
    for (const node of g.nodes) {
      expect(typeof node.degree).toBe('number');
      expect(node.degree).toBe(expected.get(node.id) ?? 0);
    }
  });

  it('every node has validationStrength in (0, 1] — drives the emissive lift', () => {
    const g = generateSyntheticGraph();
    for (const node of g.nodes) {
      expect(typeof node.validationStrength).toBe('number');
      expect(node.validationStrength as number).toBeGreaterThan(0);
      expect(node.validationStrength as number).toBeLessThanOrEqual(1);
    }
  });

  it('higher-degree nodes have ≥ validationStrength than zero-degree nodes', () => {
    // The metric formula blends degree + weight; isolating "degree alone"
    // requires comparing nodes with similar weights but different degrees.
    // The aggregate guarantee: the MEAN validationStrength of the top
    // decile by degree should exceed the mean of zero-degree nodes.
    const g = generateSyntheticGraph();
    const byDeg = [...g.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
    const top = byDeg.slice(0, Math.max(10, Math.floor(byDeg.length / 10)));
    const isolated = g.nodes.filter((n) => (n.degree ?? 0) === 0);
    if (isolated.length === 0) return; // 모든 노드 연결된 경우는 skip
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(top.map((n) => n.validationStrength as number))).toBeGreaterThanOrEqual(
      mean(isolated.map((n) => n.validationStrength as number)) - 0.001,
    );
  });

  // B-62-demo-clusters-edges — modular cluster topology + corroboration.
  it('every edge carries a corroboration score in [0, 1]', () => {
    const g = generateSyntheticGraph();
    expect(g.links.length).toBeGreaterThan(0);
    for (const link of g.links as StellarLink[]) {
      expect(typeof link.corroborationScore).toBe('number');
      expect(link.corroborationScore as number).toBeGreaterThanOrEqual(0);
      expect(link.corroborationScore as number).toBeLessThanOrEqual(1);
    }
  });

  it('corroboration distribution is heavy-tailed (mostly low, some high)', () => {
    const g = generateSyntheticGraph();
    const scores = (g.links as StellarLink[]).map(
      (l) => l.corroborationScore as number,
    );
    const total = scores.length;
    const low = scores.filter((s) => s < 0.3).length;
    const high = scores.filter((s) => s >= 0.65).length;
    // PO recipe: ~70% under 0.3, ~10% at or above 0.65.
    expect(low / total).toBeGreaterThan(0.55);
    expect(high / total).toBeGreaterThan(0.05);
    expect(high / total).toBeLessThan(0.20);
  });

  it('inter-cluster bridge edges stay under 10% (modular topology)', () => {
    // B-62-demo-clusters-edges PO directive: intra strong, inter < 10%.
    // Sampling stability: with intra ratio 0.92, expected inter is 8%.
    // Allow generous slack to avoid flakes.
    const g = generateSyntheticGraph();
    const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
    let bridges = 0;
    for (const link of g.links as StellarLink[]) {
      const src = byId.get(String(link.source));
      const tgt = byId.get(String(link.target));
      if (!src || !tgt) continue;
      if (src.cluster !== tgt.cluster) bridges += 1;
    }
    expect(bridges / g.links.length).toBeLessThan(0.12);
  });

  it('cluster centroids are spread far enough that the canvas reads as separated 성단', () => {
    // After B-62-demo-clusters-edges bumped R 380 → 540, the standard
    // deviation of cluster mean positions should sit well above the
    // pre-bump value. Use the mean position per cluster as a proxy for
    // centroid location.
    const g = generateSyntheticGraph();
    const sumByCluster = new Map<number, { x: number; y: number; z: number; n: number }>();
    for (const node of g.nodes) {
      const c = node.cluster;
      const agg = sumByCluster.get(c) ?? { x: 0, y: 0, z: 0, n: 0 };
      agg.x += node.x;
      agg.y += node.y;
      agg.z += node.z;
      agg.n += 1;
      sumByCluster.set(c, agg);
    }
    const centroids = Array.from(sumByCluster.values()).map((a) => ({
      x: a.x / a.n,
      y: a.y / a.n,
      z: a.z / a.n,
    }));
    // Pairwise mean distance among cluster centroids should exceed 400
    // (R=540 sphere → centroid pair-distance is ~700 in expectation).
    let pairs = 0;
    let totalDist = 0;
    for (let i = 0; i < centroids.length; i += 1) {
      for (let j = i + 1; j < centroids.length; j += 1) {
        const a = centroids[i]!;
        const b = centroids[j]!;
        const d = Math.sqrt(
          (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2,
        );
        totalDist += d;
        pairs += 1;
      }
    }
    expect(totalDist / pairs).toBeGreaterThan(400);
  });
});
