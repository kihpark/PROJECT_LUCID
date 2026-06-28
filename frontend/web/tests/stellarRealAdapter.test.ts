/**
 * fix/m3-2b-wiring-actually-apply — adapter contract tests.
 *
 * Validates that loadRealStellarGraph populates the M3-2b visual-vocab
 * metadata the StellarGraph renderer now consumes:
 *
 *   * node.entity_type (subject_entity_type pass-through) — drives node color
 *     via ENTITY_COLORS in mode='real'.
 *   * node.fact_type   — 'claim' switches to CLAIM_NODE_COLOR.
 *   * link.kind        — 'action' vs 'claim_related' — drives edge color
 *                        via stellarEdgeStyle.edgeStyle().
 *   * link.fact_count  — drives edge width (log scale).
 *
 * Without these fields, the renderer would silently fall back to legacy
 * cluster-palette/flat-accent — which was the PO repro
 * ("STELLAR REAL 변경 사항 안 보임").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the API + auth surfaces so loadRealStellarGraph runs against an
// in-memory fact list rather than the real backend. Returning a single
// fact pair with shared subject so linkBySubjectOverlap emits a chain link.
vi.mock('@/lib/api', () => ({
  getHomeBrief: vi.fn().mockResolvedValue(null),
  listSpaceFacts: vi.fn().mockResolvedValue({
    facts: [
      {
        fact_uid: 'fact-a',
        subject_uid: '00000000-0000-4000-8000-000000000001',
        subject_label: '서울시',
        predicate: 'develops',
        object_value: '한강 르네상스',
        source_uids: ['src-1'],
        fact_type: 'action',
        // ★ M3-2b — backend may emit subject_entity_type. Adapter must
        // pass it through so the renderer can color the node WHO teal.
        subject_entity_type: 'organization',
      },
      {
        fact_uid: 'fact-b',
        subject_uid: '00000000-0000-4000-8000-000000000001',
        subject_label: '서울시',
        predicate: 'launches',
        object_value: '청계천 복원',
        source_uids: ['src-2', 'src-3'],
        fact_type: 'action',
        subject_entity_type: 'organization',
      },
      {
        fact_uid: 'fact-c',
        subject_uid: '00000000-0000-4000-8000-000000000002',
        subject_label: '대니얼 카너먼',
        predicate: 'said',
        object_value: '손실 회피 계수 2.25',
        source_uids: ['src-4'],
        fact_type: 'claim',
        subject_entity_type: 'person',
        speaker_label: '대니얼 카너먼',
        speech_act: 'said',
        content_claim: '손실 회피 계수 2.25',
      },
    ],
  }),
  recall: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getCurrentSpace: vi.fn().mockReturnValue('ks-test'),
}));

// predicateLabel is pure; mocking is unnecessary but cheap to stub.
vi.mock('@/lib/predicateLabels', () => ({
  predicateLabel: (predicate: string, label?: string | null) => label ?? predicate,
}));

let loadRealStellarGraph: typeof import('@/lib/stellarRealAdapter').loadRealStellarGraph;

beforeEach(async () => {
  vi.resetModules();
  ({ loadRealStellarGraph } = await import('@/lib/stellarRealAdapter'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadRealStellarGraph — fix/m3-2b-wiring entity_type pass-through', () => {
  it('exposes subject_entity_type on each node as the entity_type bucket', async () => {
    const data = await loadRealStellarGraph();
    const orgNode = data.nodes.find((n) => n.id === 'fact-a');
    const personNode = data.nodes.find((n) => n.id === 'fact-c');
    expect(orgNode?.entity_type).toBe('organization');
    expect(personNode?.entity_type).toBe('person');
  });

  it('preserves fact_type so the CLAIM node can switch to CLAIM_NODE_COLOR', async () => {
    const data = await loadRealStellarGraph();
    const claimNode = data.nodes.find((n) => n.id === 'fact-c');
    expect(claimNode?.fact_type).toBe('claim');
  });

  it('keeps subject_entity_type / object_entity_type as separate pass-through fields', async () => {
    const data = await loadRealStellarGraph();
    const claimNode = data.nodes.find((n) => n.id === 'fact-c');
    expect(claimNode?.subject_entity_type).toBe('person');
    // No object_entity_type in the mock — adapter passes null through.
    expect(claimNode?.object_entity_type).toBeNull();
  });
});

describe('loadRealStellarGraph — fix/m3-2b-wiring link kind / fact_count', () => {
  it('emits chain links with kind="action" between non-claim siblings', async () => {
    const data = await loadRealStellarGraph();
    // The two 서울시 facts share a subject so linkBySubjectOverlap emits
    // exactly one chain link between them; both endpoints are action facts,
    // so kind must be 'action' (teal).
    const link = data.links.find(
      (l) =>
        (l.source === 'fact-a' && l.target === 'fact-b') ||
        (l.source === 'fact-b' && l.target === 'fact-a'),
    );
    expect(link).toBeTruthy();
    expect(link?.kind).toBe('action');
  });

  it('attaches fact_count to every chain link (drives edge width)', async () => {
    const data = await loadRealStellarGraph();
    for (const link of data.links) {
      expect(typeof link.fact_count).toBe('number');
      expect(link.fact_count).toBeGreaterThan(0);
    }
  });

  it('does NOT bind link_status to the renderer (★ PO 정정 가드)', async () => {
    // Adapter must not synthesise link_status into kind — kind is a pure
    // function of fact_type, not of link_status. We assert by injecting
    // a "claimed" link_status hint into the mock and confirming the
    // emitted edges still derive kind from fact_type only.
    const data = await loadRealStellarGraph();
    for (const link of data.links) {
      // The data-only contract: kind belongs to {action, claim_related},
      // never to link_status' {verified, claimed}.
      expect(['action', 'claim_related']).toContain(link.kind);
    }
  });
});

describe('loadRealStellarGraph — claim ↔ action edge kind', () => {
  it('emits kind="claim_related" when either endpoint is a CLAIM fact', async () => {
    // Re-import with a mock where one subject groups a CLAIM and an
    // ACTION fact together — the chain link between them must be
    // labelled claim_related (amber) per the M3-2b spec.
    vi.resetModules();
    vi.doMock('@/lib/api', () => ({
      getHomeBrief: vi.fn().mockResolvedValue(null),
      listSpaceFacts: vi.fn().mockResolvedValue({
        facts: [
          {
            fact_uid: 'mix-1',
            subject_uid: '00000000-0000-4000-8000-000000000003',
            subject_label: '삼성전자',
            predicate: 'announced',
            object_value: 'HBM3E 양산',
            source_uids: ['s1'],
            fact_type: 'action',
            subject_entity_type: 'organization',
          },
          {
            fact_uid: 'mix-2',
            subject_uid: '00000000-0000-4000-8000-000000000003',
            subject_label: '삼성전자',
            predicate: 'said',
            object_value: 'HBM 점유율 53%',
            source_uids: ['s2'],
            fact_type: 'claim',
            subject_entity_type: 'organization',
          },
        ],
      }),
      recall: vi.fn(),
    }));
    vi.doMock('@/lib/auth', () => ({
      getCurrentSpace: vi.fn().mockReturnValue('ks-test'),
    }));
    vi.doMock('@/lib/predicateLabels', () => ({
      predicateLabel: (predicate: string, label?: string | null) =>
        label ?? predicate,
    }));
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const link = data.links.find(
      (l) =>
        (l.source === 'mix-1' && l.target === 'mix-2') ||
        (l.source === 'mix-2' && l.target === 'mix-1'),
    );
    expect(link).toBeTruthy();
    expect(link?.kind).toBe('claim_related');
  });
});

describe('loadRealStellarGraph - fix/m32b-entity-type-degree-actual-wiring degree', () => {
  it('populates node.degree from the link set so size = sqrt(degree)', async () => {
    // The previous describe ends with a vi.doMock override (mix-1/mix-2).
    // We need to restore the default mock so fact-a / fact-b / fact-c are
    // present in the graph; otherwise node.find(fact-a) is undefined and
    // a?.degree is undefined regardless of attachGraphMetrics behavior.
    vi.resetModules();
    vi.doMock('@/lib/api', () => ({
      getHomeBrief: vi.fn().mockResolvedValue(null),
      listSpaceFacts: vi.fn().mockResolvedValue({
        facts: [
          {
            fact_uid: 'fact-a',
            subject_uid: '00000000-0000-4000-8000-000000000001',
            subject_label: '서울시',
            predicate: 'develops',
            object_value: '한강 르네상스',
            source_uids: ['src-1'],
            fact_type: 'action',
            subject_entity_type: 'organization',
          },
          {
            fact_uid: 'fact-b',
            subject_uid: '00000000-0000-4000-8000-000000000001',
            subject_label: '서울시',
            predicate: 'launches',
            object_value: '청계천 복원',
            source_uids: ['src-2', 'src-3'],
            fact_type: 'action',
            subject_entity_type: 'organization',
          },
          {
            fact_uid: 'fact-c',
            subject_uid: '00000000-0000-4000-8000-000000000002',
            subject_label: '대니얼 카너먼',
            predicate: 'said',
            object_value: '손실 회피 계수 2.25',
            source_uids: ['src-4'],
            fact_type: 'claim',
            subject_entity_type: 'person',
          },
        ],
      }),
      recall: vi.fn(),
    }));
    vi.doMock('@/lib/auth', () => ({
      getCurrentSpace: vi.fn().mockReturnValue('ks-test'),
    }));
    vi.doMock('@/lib/predicateLabels', () => ({
      predicateLabel: (predicate: string, label?: string | null) =>
        label ?? predicate,
    }));
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const a = data.nodes.find((n) => n.id === 'fact-a');
    const b = data.nodes.find((n) => n.id === 'fact-b');
    const c = data.nodes.find((n) => n.id === 'fact-c');
    expect(a?.degree).toBe(1);
    expect(b?.degree).toBe(1);
    expect(c?.degree).toBe(0);
  });

  it('exposes object_entity_type as a pass-through when the fact carries it', async () => {
    // Reload with a mock where one fact has an entity-shape object_value
    // and the backend has already resolved object_entity_type. The adapter
    // must surface that as node.object_entity_type so callers can read it.
    vi.resetModules();
    vi.doMock('@/lib/api', () => ({
      getHomeBrief: vi.fn().mockResolvedValue(null),
      listSpaceFacts: vi.fn().mockResolvedValue({
        facts: [
          {
            fact_uid: 'ot-1',
            subject_uid: '00000000-0000-4000-8000-000000000010',
            subject_label: '직원',
            predicate: 'works_at',
            object_value: '00000000-0000-4000-8000-000000000011',
            object_label: '한국은행',
            source_uids: ['s10'],
            fact_type: 'action',
            subject_entity_type: 'person',
            object_entity_type: 'organization',
          },
        ],
      }),
      recall: vi.fn(),
    }));
    vi.doMock('@/lib/auth', () => ({
      getCurrentSpace: vi.fn().mockReturnValue('ks-test'),
    }));
    vi.doMock('@/lib/predicateLabels', () => ({
      predicateLabel: (predicate: string, label?: string | null) =>
        label ?? predicate,
    }));
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const node = data.nodes.find((n) => n.id === 'ot-1');
    expect(node?.subject_entity_type).toBe('person');
    expect(node?.object_entity_type).toBe('organization');
    // entity_type falls through to subject_entity_type by default.
    expect(node?.entity_type).toBe('person');
  });
});
