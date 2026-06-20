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
});
