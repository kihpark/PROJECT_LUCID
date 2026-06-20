/**
 * B-62 — Stellar View synthetic data generator.
 *
 * Produces a deterministic, marketing-grade galaxy of facts for the
 * Stellar View spike. The synthetic surface is what the first-time
 * visitor sees so the "오" moment fires before any real KS data is
 * loaded — see DR-stellar / B-62 brief.
 *
 * Design contract:
 *   - Deterministic given a seed (own LCG, no Math.random anywhere).
 *   - 1500–3000 nodes (default ≈ 2000) shaped as 5–8 thematic clusters.
 *   - ~80% of edges live INSIDE a cluster (galactic arms);
 *     ~20% bridge across clusters (intergalactic filaments).
 *   - Edge type ratios (the recipe): supports ~60% / elaborates ~20% /
 *     causes ~15% / contradicts ~5%.
 *   - Korean-flavored labels mixing 사람 / 사건 / 개념 / 조직 / 장소.
 *   - Cluster centroids placed on a sphere; node positions are centroid
 *     plus Gaussian jitter so the layout naturally forms galaxies.
 *
 * This module is pure: no React, no DOM, no fetch. Tests pin the
 * shape; the StellarGraph wrapper consumes the output.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32-style LCG). We avoid Math.random because the
// tests assert "same seed → identical output".
// ---------------------------------------------------------------------------

/** Tiny deterministic 32-bit PRNG. Seed of 0 is rewritten to 1 to avoid the
 *  degenerate all-zero stream. */
export function createRng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return function next(): number {
    // mulberry32 — fast, decent distribution for visual jitter, zero deps.
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform — turns two uniforms into a standard-normal sample.
 *  Used to give cluster halos a Gaussian falloff. */
function gaussian(rng: () => number): number {
  let u = rng();
  let v = rng();
  // Guard against log(0).
  if (u < 1e-9) u = 1e-9;
  if (v < 1e-9) v = 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Public types — kept lean so StellarGraph can pass them straight into
// ForceGraph3D's graphData prop.
// ---------------------------------------------------------------------------

export type EdgeType = 'supports' | 'elaborates' | 'causes' | 'contradicts';

export interface StellarNode {
  id: string;
  label: string;
  /** 0-based cluster index this node belongs to. */
  cluster: number;
  /** Source-count analogue. Kept for backward compat — newer surfaces should
   *  prefer `degree` for size and `validationStrength` for emissive feel. */
  weight: number;
  /** B-62-v1 — actual graph degree (in + out edges incident on this node).
   *  Populated by `attachGraphMetrics` after the generator builds the link
   *  set. The Stellar renderer drives node size from this so size === how
   *  connected the fact is, not a random sample. */
  degree?: number;
  /** B-62-v1 — 0..1 scalar derived from validation provenance (source count
   *  for real, weight for synthetic). Drives the emissive lift in nodeColor:
   *  well-validated facts glow brighter. */
  validationStrength?: number;
  /** Initial 3D position seeded by the generator (ForceGraph3D respects x/y/z). */
  x: number;
  y: number;
  z: number;
  /** A short Korean entity-style label so the tooltip is meaningful. */
  subject: string;
  predicate: string;
  object: string;
}

export interface StellarLink {
  source: string;
  target: string;
  type: EdgeType;
  /** B-62-demo-clusters-edges — 0..1 corroboration score. Drives edge
   *  brightness in the renderer (high = bright constellation, low =
   *  dim background filament). For the demo we sample a heavy-tailed
   *  distribution so most edges sit at low scores and a small minority
   *  flare up. Real-mode edges leave this undefined; the renderer
   *  falls back to a flat accent. */
  corroborationScore?: number;
}

export interface StellarGraphData {
  nodes: StellarNode[];
  links: StellarLink[];
  /** Cluster index → human-readable theme name. */
  clusters: string[];
}

export interface SyntheticGraphOptions {
  /** Defaults to 0xC0FFEE. */
  seed?: number;
  /** Total target node count. Clamped to [1500, 3000]. Default 2000. */
  nodeCount?: number;
  /** Cluster count. Clamped to [5, 8]. Default 7. */
  clusterCount?: number;
}

// ---------------------------------------------------------------------------
// Vocabulary — Korean-flavored cluster themes and entity vocabulary. The
// labels mix 사람 / 사건 / 개념 / 조직 / 장소 per the brief.
// ---------------------------------------------------------------------------

const CLUSTER_THEMES: { name: string; subjects: string[]; objects: string[] }[] = [
  {
    name: '양자 결맞음의 사슬',
    subjects: [
      '하이젠베르크',
      '슈뢰딩거 방정식',
      '벨 부등식',
      '양자 얽힘',
      '결맞음 시간',
      'IBM 양자 프로세서',
      '구글 시카모어',
      '도쿄대 양자 연구실',
      '초전도 큐비트',
      '광자 펄스',
    ],
    objects: [
      '양자 우위',
      '결잃음 시간 50μs',
      '비국소성 검증',
      '실리콘 큐비트 배열',
      '오차 정정 코드',
      '베리먼 통계',
    ],
  },
  {
    name: 'SpaceX 1차 발사 성공 사건',
    subjects: [
      'SpaceX',
      '일론 머스크',
      '팰컨 9',
      '스타십 시험기',
      '보카치카 발사장',
      '드래곤 캡슐',
      '랩터 엔진',
      'NASA Artemis',
      '한국 누리호',
      'KARI',
    ],
    objects: [
      '재사용 가능 1단',
      '저궤도 5톤 적재',
      '메탄-LOX 추진',
      '대기권 재진입 성공',
      '발사 비용 60% 절감',
      '달 유인 착륙 계약',
    ],
  },
  {
    name: '행동경제학적 손실 회피',
    subjects: [
      '대니얼 카너먼',
      '아모스 트버스키',
      '리처드 탈러',
      '전망 이론',
      '넛지 이론',
      '심리적 계좌',
      'CMU 행동경제학과',
      '시카고 대학교',
      '서울대 의사결정 연구실',
    ],
    objects: [
      '손실 회피 계수 2.25',
      '확률 가중 함수',
      '디폴트 옵션 효과',
      '앵커링 편향',
      '확증 편향',
      '소유 효과',
    ],
  },
  {
    name: '기후 모델 정합성',
    subjects: [
      'IPCC',
      'NOAA',
      'CMIP6 모델',
      '대서양 해류 AMOC',
      '북극 얼음 면적',
      '아마존 우림',
      '이산화탄소 농도 425ppm',
      '제임스 한센',
      '기후 임계점',
    ],
    objects: [
      '+1.5℃ 시나리오',
      '해수면 0.6m 상승',
      '몬순 패턴 교란',
      '탄소 예산 300Gt',
      '메탄 방출 가속',
      '산호초 백화',
    ],
  },
  {
    name: 'AI 정렬과 거버넌스',
    subjects: [
      'OpenAI',
      'Anthropic',
      'DeepMind',
      'EU AI Act',
      'NIST AI RMF',
      '스튜어트 러셀',
      '닉 보스트롬',
      'RLHF',
      '헌법적 AI',
      '대규모 언어 모델',
    ],
    objects: [
      '인간 가치 정렬',
      '능력 평가 벤치마크',
      'API 사용 정책',
      '레드팀 결과',
      '자율 에이전트 위험',
      '오픈 웨이트 모델 정책',
    ],
  },
  {
    name: '서울 도시 인프라 전환',
    subjects: [
      '서울시',
      '한강 르네상스',
      '서울 지하철 2호선',
      '청계천 복원',
      '강남 재개발',
      '용산 국제업무지구',
      '서울대 도시계획과',
      '경복궁',
      '서울로 7017',
    ],
    objects: [
      '대중교통 분담률 65%',
      '보행자 우선 도로',
      '녹지율 28%',
      '스마트 가로등 도입',
      '미세먼지 측정망',
      '15분 도시 모델',
    ],
  },
  {
    name: '암 면역 치료의 진화',
    subjects: [
      'CAR-T 치료',
      '제임스 앨리슨',
      '혼조 다스쿠',
      'PD-1 억제제',
      '서울아산병원',
      '국립암센터',
      'mRNA 백신 플랫폼',
      'BioNTech',
      'Moderna',
    ],
    objects: [
      '완전 관해 47%',
      '사이토카인 폭풍 위험',
      '재발 시점 18개월',
      '병용 요법 성과',
      '신생 항원 표적',
      '5년 생존율 향상',
    ],
  },
  {
    name: '한국 반도체 수출 동향',
    subjects: [
      '삼성전자',
      'SK하이닉스',
      'TSMC',
      '인텔 파운드리',
      '엔비디아 H100',
      'HBM3E',
      '평택 캠퍼스',
      '용인 클러스터',
      '미국 상무부',
    ],
    objects: [
      '메모리 단가 +35%',
      '파운드리 2nm 양산',
      'HBM 점유율 53%',
      '수출 통제 면제',
      '설비 투자 30조원',
      '데이터센터 수요 폭증',
    ],
  },
];

const PREDICATES_BY_TYPE: Record<EdgeType, string[]> = {
  supports: ['supports', 'is_examined_by', 'is_consistent_with', 'reinforces'],
  elaborates: ['elaborates', 'is_defined_by', 'specifies', 'is_subtype_of'],
  causes: ['causes', 'leads_to', 'triggers', 'enables'],
  contradicts: ['contradicts', 'falsifies', 'is_inconsistent_with'],
};

// ---------------------------------------------------------------------------
// Generator core.
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 0xc0ffee;
const NODE_MIN = 1500;
const NODE_MAX = 3000;
const CLUSTER_MIN = 5;
const CLUSTER_MAX = 8;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Pick an item from `arr` deterministically using rng(). */
function pick<T>(rng: () => number, arr: readonly T[]): T {
  const idx = Math.floor(rng() * arr.length);
  // Floor can equal arr.length when rng() returns exactly 1.0 — clamp.
  return arr[Math.min(idx, arr.length - 1)] as T;
}

/** Choose an edge type biased to the recipe ratios. */
function pickEdgeType(rng: () => number): EdgeType {
  const u = rng();
  // supports 60% / elaborates 20% / causes 15% / contradicts 5%
  if (u < 0.6) return 'supports';
  if (u < 0.8) return 'elaborates';
  if (u < 0.95) return 'causes';
  return 'contradicts';
}

/** B-62-demo-clusters-edges — heavy-tailed corroboration score sampler.
 *
 * PO directive: "데모는 mock 분포(대부분 낮고 일부 높음)". Distribution:
 *   70% in [0.05, 0.30]   — background filaments
 *   20% in [0.30, 0.65]   — moderate links
 *   10% in [0.65, 1.00]   — bright constellation edges
 *
 * Drives both opacity (alpha = score) and a modest width ramp in the
 * renderer, so the high-corroboration sub-graph visually pops out of
 * the rest as a brighter star-pattern.
 */
function sampleCorroboration(rng: () => number): number {
  const u = rng();
  if (u < 0.70) return 0.05 + rng() * 0.25;
  if (u < 0.90) return 0.30 + rng() * 0.35;
  return 0.65 + rng() * 0.35;
}

/**
 * Generate the synthetic stellar graph.
 *
 * The shape:
 *   1. Pick clusterCount cluster themes (cycling through CLUSTER_THEMES if
 *      we ever extend the cap above the seed theme count).
 *   2. Place each cluster centroid on the surface of a sphere of radius R,
 *      using golden-angle spacing so they spread evenly.
 *   3. Distribute nodes across clusters (roughly even, with small jitter so
 *      not every cluster is the same size — galaxies vary).
 *   4. For each node, draw a position = centroid + Gaussian(σ) on each axis.
 *   5. Build edges: ~3 per node on average. With probability 0.8 the edge
 *      stays inside the source cluster; otherwise it bridges to a random
 *      other cluster. Type is drawn from pickEdgeType().
 */
export function generateSyntheticGraph(
  options: SyntheticGraphOptions = {},
): StellarGraphData {
  const seed = options.seed ?? DEFAULT_SEED;
  const targetNodes = clamp(options.nodeCount ?? 2000, NODE_MIN, NODE_MAX);
  const clusterCount = clamp(options.clusterCount ?? 7, CLUSTER_MIN, CLUSTER_MAX);

  const rng = createRng(seed);

  // Step 1: pick cluster themes (cycle through seed list).
  const clusters: string[] = [];
  for (let c = 0; c < clusterCount; c += 1) {
    const theme = CLUSTER_THEMES[c % CLUSTER_THEMES.length] as (typeof CLUSTER_THEMES)[number];
    clusters.push(theme.name);
  }

  // Step 2: cluster centroids on a sphere (golden-angle Fibonacci spiral).
  // B-62-demo-clusters-edges — bumped 380 → 540 to push centroids apart;
  // combined with the tighter halo σ below and the d3 charge tuning in
  // StellarGraph, clusters now read as separated 성단 rather than one
  // central blob.
  const R = 540;
  const centroids: { x: number; y: number; z: number }[] = [];
  const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
  for (let c = 0; c < clusterCount; c += 1) {
    const y = 1 - (c / Math.max(1, clusterCount - 1)) * 2; // [-1, 1]
    const radius = Math.sqrt(1 - y * y);
    const theta = phi * c;
    centroids.push({
      x: Math.cos(theta) * radius * R,
      y: y * R,
      z: Math.sin(theta) * radius * R,
    });
  }

  // Step 3: cluster sizing — base share + jitter (±15%) so galaxies vary.
  const baseShare = targetNodes / clusterCount;
  const sizes: number[] = [];
  let allocated = 0;
  for (let c = 0; c < clusterCount; c += 1) {
    const jitter = 1 + (rng() - 0.5) * 0.3; // 0.85 .. 1.15
    const size = Math.max(1, Math.round(baseShare * jitter));
    sizes.push(size);
    allocated += size;
  }
  // Correct rounding drift so the total stays in the clamp window.
  const drift = targetNodes - allocated;
  if (drift !== 0) {
    sizes[0] = Math.max(1, sizes[0]! + drift);
  }

  // Step 4: emit nodes.
  const nodes: StellarNode[] = [];
  const nodesByCluster: string[][] = Array.from({ length: clusterCount }, () => []);
  // B-62-demo-clusters-edges — halo σ tightened 55 → 32 so each cluster
  // is a more compact ball (intra connections collapse onto it cleanly),
  // and the gap between centroids reads as real space.
  const SIGMA = 32;

  for (let c = 0; c < clusterCount; c += 1) {
    const centroid = centroids[c] as { x: number; y: number; z: number };
    const theme = CLUSTER_THEMES[c % CLUSTER_THEMES.length] as (typeof CLUSTER_THEMES)[number];
    const size = sizes[c] as number;
    for (let i = 0; i < size; i += 1) {
      const id = `syn-${c}-${i}`;
      const subject = pick(rng, theme.subjects);
      const object = pick(rng, theme.objects);
      // Pick a default predicate biased toward 'supports' for label nicety.
      const predicate = pick(rng, PREDICATES_BY_TYPE.supports);
      const weight = 1 + Math.floor(rng() * 8); // 1..8 (source-count analogue)
      nodes.push({
        id,
        label: `${subject} · ${object}`,
        cluster: c,
        weight,
        x: centroid.x + gaussian(rng) * SIGMA,
        y: centroid.y + gaussian(rng) * SIGMA,
        z: centroid.z + gaussian(rng) * SIGMA,
        subject,
        predicate,
        object,
      });
      nodesByCluster[c]!.push(id);
    }
  }

  // Step 5: emit edges. Target ~2.6 edges per node on average → density that
  // still feels like a galaxy without melting the GPU.
  // B-62-demo-clusters-edges — intra ratio 80% → 92% so inter-cluster
  // bridges sit under 10% (PO directive). Combined with the tighter
  // halos this gives the modular topology the spec asks for.
  const edgeTarget = Math.round(nodes.length * 2.6);
  const links: StellarLink[] = [];
  const seen = new Set<string>();

  for (let e = 0; e < edgeTarget; e += 1) {
    const sourceNode = nodes[Math.floor(rng() * nodes.length)] as StellarNode;
    const intra = rng() < 0.92;
    let targetCluster = sourceNode.cluster;
    if (!intra && clusterCount > 1) {
      // Pick a DIFFERENT cluster.
      let other = Math.floor(rng() * clusterCount);
      if (other === sourceNode.cluster) other = (other + 1) % clusterCount;
      targetCluster = other;
    }
    const pool = nodesByCluster[targetCluster] as string[];
    if (pool.length === 0) continue;
    const targetId = pool[Math.floor(rng() * pool.length)] as string;
    if (targetId === sourceNode.id) continue;
    // De-dup so we don't double-count an edge between the same pair.
    const key =
      sourceNode.id < targetId
        ? `${sourceNode.id}|${targetId}`
        : `${targetId}|${sourceNode.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      source: sourceNode.id,
      target: targetId,
      type: pickEdgeType(rng),
      corroborationScore: sampleCorroboration(rng),
    });
  }

  return attachGraphMetrics({ nodes, links, clusters });
}

// ---------------------------------------------------------------------------
// B-62-v1 — shared post-build pass that populates node.degree and
// node.validationStrength. Pure function so the real adapter can call it
// too. Both metrics are derived from the link set, so this MUST run after
// links are finalised.
//
// * degree            — number of edges incident on the node. Drives node
//                       size in the renderer (size = sqrt(degree)).
// * validationStrength — 0..1 confidence proxy. Higher = brighter glow.
//                       For synthetic we map (weight + degree) onto 0..1
//                       so popular clusters look more "validated"; the real
//                       adapter overrides this with a true source-count
//                       calculation before calling us.
// ---------------------------------------------------------------------------

export function attachGraphMetrics(data: StellarGraphData): StellarGraphData {
  const degree = new Map<string, number>();
  for (const link of data.links) {
    degree.set(String(link.source), (degree.get(String(link.source)) ?? 0) + 1);
    degree.set(String(link.target), (degree.get(String(link.target)) ?? 0) + 1);
  }
  const nodes = data.nodes.map((n) => {
    const d = degree.get(n.id) ?? 0;
    const w = n.weight ?? 1;
    // Soft sigmoid-ish blend of degree (network importance) and weight
    // (source-count analogue). Anchored so a 0-degree node still glows
    // at ~0.3, never invisible.
    const raw = 0.3 + 0.5 * Math.tanh(d / 6) + 0.2 * Math.tanh(w / 4);
    const validationStrength = n.validationStrength ?? Math.max(0.3, Math.min(1, raw));
    return { ...n, degree: d, validationStrength };
  });
  return { nodes, links: data.links, clusters: data.clusters };
}

// ---------------------------------------------------------------------------
// Edge color recipe — exported so StellarGraph and tests stay in sync.
// ---------------------------------------------------------------------------

export const EDGE_COLORS: Record<EdgeType, string> = {
  supports: '#5be39a',     // mint green
  elaborates: '#39d3ec',   // cyan
  causes: '#f5b95c',       // amber
  contradicts: '#f06a78',  // soft red
};

/** Accent palette used to color nodes by cluster. Length doesn't need to
 *  match clusterCount — we index modulo .length. */
export const CLUSTER_PALETTE: string[] = [
  '#3fe0c6',
  '#39d3ec',
  '#5be39a',
  '#b4a7ff',
  '#f5b95c',
  '#7ed8ff',
  '#f06a78',
  '#9be3c2',
];
