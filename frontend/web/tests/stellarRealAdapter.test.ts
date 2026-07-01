/**
 * feat/stellar-entity-edge-remodel-v2 — adapter contract tests.
 *
 * The v2 model:
 *   - node = entity (NOT fact). Multiple facts about the same entity pair
 *     collapse into one edge with accumulated fact_count.
 *   - ACTION fact -> subject entity -> object entity (entity-edge).
 *   - CLAIM fact  -> claim node + speaker entity edge + related entity edges.
 *   - MEASUREMENT -> entity property (NEVER a node).
 *
 * These tests pin the canonical PO acceptance scenario ("강재호 -> 이로운몰
 * 설립") and the fall-through behaviors (literal object_value, multi-fact
 * collapse, claim modality, measurement-as-attribute, entity degree).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  getCurrentSpace: vi.fn().mockReturnValue('ks-test'),
}));

vi.mock('@/lib/predicateLabels', () => ({
  predicateLabel: (predicate: string, label?: string | null) =>
    label ?? predicate,
}));

const UID = {
  KANG: '11111111-1111-4111-8111-111111111111',
  IROUNMALL: '22222222-2222-4222-8222-222222222222',
  KAHNEMAN: '33333333-3333-4333-8333-333333333333',
  SAMSUNG: '44444444-4444-4444-8444-444444444444',
  HBM: '55555555-5555-4555-8555-555555555555',
  TSMC: '66666666-6666-4666-8666-666666666666',
  REL_X: '77777777-7777-4777-8777-777777777777',
};

function mockApi(facts: unknown[], brief: unknown = null) {
  vi.doMock('@/lib/api', () => ({
    getHomeBrief: vi.fn().mockResolvedValue(brief),
    listSpaceFacts: vi.fn().mockResolvedValue({ facts, total: facts.length, truncated: false }),
    recall: vi.fn().mockResolvedValue({ facts: [], total: 0 }),
    // ★ REQ-013 (PO 2026-07-02) — adapter 가 isMeaningfulLabel 을 import 하므로
    //   mock 에도 함께 노출. 옛 real 구현 규약과 동일한 semantics.
    isMeaningfulLabel: (label: string | null | undefined) => {
      if (!label) return false;
      const trimmed = label.trim();
      if (!trimmed) return false;
      return /[\p{L}\p{N}]/u.test(trimmed);
    },
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Acceptance 1: ACTION -> entity-edge (강재호 -> 이로운몰 설립)', () => {
  it('emits an action edge between the two entity nodes labelled by the predicate', async () => {
    mockApi([
      {
        fact_uid: 'fact-kang-founded',
        subject_uid: UID.KANG,
        subject_label: '강재호',
        subject_entity_type: 'person',
        predicate: '설립',
        object_value: UID.IROUNMALL,
        object_label: '이로운몰',
        object_entity_type: 'organization',
        source_uids: ['s1'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();

    const kang = data.nodes.find((n) => n.id === UID.KANG);
    const irounmall = data.nodes.find((n) => n.id === UID.IROUNMALL);
    expect(kang?.kind).toBe('entity');
    expect(irounmall?.kind).toBe('entity');
    expect(kang?.label).toBe('강재호');
    expect(irounmall?.label).toBe('이로운몰');

    const edge = data.links.find(
      (l) => l.source === UID.KANG && l.target === UID.IROUNMALL,
    );
    expect(edge).toBeTruthy();
    expect(edge?.kind).toBe('action');
    expect(edge?.predicate).toBe('설립');
    expect(edge?.fact_count).toBe(1);
  });

  it('★ PO acceptance #1: fact is NOT a node — only entities are nodes', async () => {
    mockApi([
      {
        fact_uid: 'fact-kang-founded',
        subject_uid: UID.KANG,
        subject_label: '강재호',
        subject_entity_type: 'person',
        predicate: '설립',
        object_value: UID.IROUNMALL,
        object_label: '이로운몰',
        object_entity_type: 'organization',
        source_uids: ['s1'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    // No node with id === fact_uid.
    const factNode = data.nodes.find((n) => n.id === 'fact-kang-founded');
    expect(factNode).toBeUndefined();
  });
});

describe('Multi-fact ACTION pairs collapse to one edge with fact_count', () => {
  it('two facts on the same (subject, object) pair -> one edge, fact_count = 2', async () => {
    mockApi([
      {
        fact_uid: 'f1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '발표',
        object_value: UID.HBM,
        object_label: 'HBM3E 양산',
        object_entity_type: 'product',
        source_uids: ['s1'],
        fact_type: 'action',
      },
      {
        fact_uid: 'f2',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '출하',
        object_value: UID.HBM,
        object_label: 'HBM3E 양산',
        object_entity_type: 'product',
        source_uids: ['s2'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const edges = data.links.filter(
      (l) => l.source === UID.SAMSUNG && l.target === UID.HBM,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.fact_count).toBe(2);
    expect(edges[0]?.predicates).toEqual(['발표', '출하']);
  });
});

describe('CLAIM -> claim node + speaker edge + related entity edges', () => {
  it('emits a claim node (kind="claim", id=fact_uid) with speech_act + content_claim', async () => {
    mockApi([
      {
        fact_uid: 'claim-kahneman-1',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: '손실 회피 계수 2.25',
        source_uids: ['s1'],
        fact_type: 'claim',
        speaker_label: '대니얼 카너먼',
        speech_act: 'judgment',
        content_claim: '손실 회피 계수 2.25',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const claim = data.nodes.find((n) => n.id === 'claim-kahneman-1');
    expect(claim?.kind).toBe('claim');
    expect(claim?.fact_type).toBe('claim');
    expect(claim?.speech_act).toBe('judgment');
    expect(claim?.content_claim).toBe('손실 회피 계수 2.25');
  });

  it('emits a speaker entity node + speaker edge from speaker -> claim node', async () => {
    mockApi([
      {
        fact_uid: 'claim-kahneman-1',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: '손실 회피 계수 2.25',
        source_uids: ['s1'],
        fact_type: 'claim',
        speaker_uid: UID.KAHNEMAN,
        speaker_label: '대니얼 카너먼',
        speech_act: 'judgment',
        content_claim: '손실 회피 계수 2.25',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const speakerNode = data.nodes.find((n) => n.id === UID.KAHNEMAN);
    expect(speakerNode?.kind).toBe('entity');
    const speakerEdge = data.links.find(
      (l) => l.source === UID.KAHNEMAN && l.target === 'claim-kahneman-1',
    );
    expect(speakerEdge).toBeTruthy();
    expect(speakerEdge?.kind).toBe('speaker');
  });

  it('emits claim_related edges from claim node -> each related entity', async () => {
    mockApi([
      {
        fact_uid: 'claim-rel-1',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: 'X',
        source_uids: ['s1'],
        fact_type: 'claim',
        speaker_uid: UID.KAHNEMAN,
        speaker_label: '대니얼 카너먼',
        speech_act: 'assertion',
        content_claim: 'X',
        related_entity_uids: [UID.REL_X],
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const rel = data.nodes.find((n) => n.id === UID.REL_X);
    expect(rel?.kind).toBe('entity');
    const edge = data.links.find(
      (l) => l.source === 'claim-rel-1' && l.target === UID.REL_X,
    );
    expect(edge?.kind).toBe('claim_related');
  });

  it('falls back to a deterministic speaker stub id when speaker_uid is absent', async () => {
    mockApi([
      {
        fact_uid: 'claim-stub-1',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: 'X',
        source_uids: ['s1'],
        fact_type: 'claim',
        // No speaker_uid — only speaker_label.
        speaker_label: '대니얼 카너먼',
        speech_act: 'assertion',
        content_claim: 'X',
      },
      {
        fact_uid: 'claim-stub-2',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: 'Y',
        source_uids: ['s1'],
        fact_type: 'claim',
        speaker_label: '대니얼 카너먼',
        speech_act: 'assertion',
        content_claim: 'Y',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    // Same speaker_label -> same stub node.
    const stubs = data.nodes.filter((n) =>
      typeof n.id === 'string' && n.id.startsWith('claim-speaker:'),
    );
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.kind).toBe('entity');
    // Two speaker edges originating from the stub.
    const speakerEdges = data.links.filter(
      (l) => typeof l.source === 'string' && l.source.startsWith('claim-speaker:') && l.kind === 'speaker',
    );
    expect(speakerEdges).toHaveLength(2);
  });
});

describe('MEASUREMENT -> entity property (★ never a node)', () => {
  it('attaches the measurement to the subject entity, NOT a separate node', async () => {
    mockApi([
      {
        fact_uid: 'measure-1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: 'has_metric',
        object_value: '53',
        source_uids: ['s1'],
        fact_type: 'measurement',
        metric: 'HBM 점유율',
        measurement_value: 53,
        measurement_unit: '%',
        as_of: '2026-06-29',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    // No measurement-as-node.
    const m = data.nodes.find((n) => n.id === 'measure-1');
    expect(m).toBeUndefined();
    // Measurement is attached to the entity.
    const samsung = data.nodes.find((n) => n.id === UID.SAMSUNG);
    expect(samsung?.kind).toBe('entity');
    expect(samsung?.measurements).toEqual([
      {
        metric: 'HBM 점유율',
        value: 53,
        unit: '%',
        as_of: '2026-06-29',
        fact_uid: 'measure-1',
      },
    ]);
  });
});

describe('object_value literal -> skip edge (entity still surfaces)', () => {
  it('does not emit an action edge when object_value is a literal', async () => {
    mockApi([
      {
        fact_uid: 'literal-1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '발표',
        // Literal object (Korean string, not a UUID).
        object_value: '메모리 단가 +35%',
        source_uids: ['s1'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const samsung = data.nodes.find((n) => n.id === UID.SAMSUNG);
    // Subject entity is in the graph.
    expect(samsung).toBeTruthy();
    // No edge whose source is samsung.
    expect(data.links.filter((l) => l.source === UID.SAMSUNG)).toHaveLength(0);
  });
});


describe('★ PO acceptance #4: node degree = entity link count', () => {
  it('three action facts from one subject -> degree 3 on the subject', async () => {
    mockApi([
      {
        fact_uid: 'f1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '발표',
        object_value: UID.HBM,
        object_label: 'HBM',
        object_entity_type: 'product',
        source_uids: ['s1'],
        fact_type: 'action',
      },
      {
        fact_uid: 'f2',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '경쟁',
        object_value: UID.TSMC,
        object_label: 'TSMC',
        object_entity_type: 'organization',
        source_uids: ['s2'],
        fact_type: 'action',
      },
      {
        fact_uid: 'f3',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '협력',
        object_value: UID.IROUNMALL,
        object_label: '이로운몰',
        object_entity_type: 'organization',
        source_uids: ['s3'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const samsung = data.nodes.find((n) => n.id === UID.SAMSUNG);
    expect(samsung?.degree).toBe(3);
  });
});

// ★ fix/entitycard-fact-count-and-dot-suggestion — fact_counts accumulation
//   independent of edge generation. The 강재호 PO scenario lives here.
describe('fact_counts (★ fix/entitycard-fact-count-and-dot-suggestion)', () => {
  it('ACTION with literal object → subject fact_counts.action = 1 (no edge)', async () => {
    // ★ 강재호 / "이로운몰 설립" scenario verbatim. No entity-edge is drawn
    //   because object_value is a literal — but the fact_count MUST reflect
    //   the underlying fact's existence so the EntityCard reads "행동 1".
    mockApi([
      {
        fact_uid: 'fact-kang-literal',
        subject_uid: UID.KANG,
        subject_label: '강재호',
        subject_entity_type: 'person',
        predicate: '설립',
        object_value: '이로운몰 설립',
        source_uids: ['s1'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const kang = data.nodes.find((n) => n.id === UID.KANG);
    expect(kang?.fact_counts?.action).toBe(1);
    expect(kang?.fact_counts?.claim).toBe(0);
    expect(kang?.fact_counts?.measurement).toBe(0);
    // ★ no link emitted — counts came from the fact itself.
    expect(data.links.filter((l) => l.source === UID.KANG)).toHaveLength(0);
  });

  it('ACTION with entity object → BOTH subject + object fact_counts.action bumped', async () => {
    mockApi([
      {
        fact_uid: 'f1',
        subject_uid: UID.KANG,
        subject_label: '강재호',
        subject_entity_type: 'person',
        predicate: '설립',
        object_value: UID.IROUNMALL,
        object_label: '이로운몰',
        object_entity_type: 'organization',
        source_uids: ['s1'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const kang = data.nodes.find((n) => n.id === UID.KANG);
    const irounmall = data.nodes.find((n) => n.id === UID.IROUNMALL);
    expect(kang?.fact_counts?.action).toBe(1);
    expect(irounmall?.fact_counts?.action).toBe(1);
  });

  it('CLAIM → speaker + each related entity fact_counts.claim bumped', async () => {
    mockApi([
      {
        fact_uid: 'claim-rel-1',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: 'X',
        source_uids: ['s1'],
        fact_type: 'claim',
        speaker_uid: UID.KAHNEMAN,
        speaker_label: '대니얼 카너먼',
        speech_act: 'assertion',
        content_claim: 'X',
        related_entity_uids: [UID.REL_X],
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const speaker = data.nodes.find((n) => n.id === UID.KAHNEMAN);
    const rel = data.nodes.find((n) => n.id === UID.REL_X);
    expect(speaker?.fact_counts?.claim).toBe(1);
    expect(rel?.fact_counts?.claim).toBe(1);
  });

  it('CLAIM with stub speaker (no speaker_uid) → stub fact_counts.claim bumped', async () => {
    mockApi([
      {
        fact_uid: 'claim-stub-1',
        subject_uid: UID.KAHNEMAN,
        subject_label: '대니얼 카너먼',
        subject_entity_type: 'person',
        predicate: 'said',
        object_value: 'X',
        source_uids: ['s1'],
        fact_type: 'claim',
        // ★ no speaker_uid — stub path.
        speaker_label: '대니얼 카너먼',
        speech_act: 'assertion',
        content_claim: 'X',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const stub = data.nodes.find(
      (n) => typeof n.id === 'string' && n.id.startsWith('claim-speaker:'),
    );
    expect(stub?.fact_counts?.claim).toBe(1);
  });

  it('MEASUREMENT → subject fact_counts.measurement bumped (in addition to measurements push)', async () => {
    mockApi([
      {
        fact_uid: 'measure-1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: 'has_metric',
        object_value: '53',
        source_uids: ['s1'],
        fact_type: 'measurement',
        metric: 'HBM 점유율',
        measurement_value: 53,
        measurement_unit: '%',
        as_of: '2026-06-29',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const samsung = data.nodes.find((n) => n.id === UID.SAMSUNG);
    expect(samsung?.fact_counts?.measurement).toBe(1);
    // ★ measurement attribute is STILL pushed (no regression).
    expect(samsung?.measurements?.length).toBe(1);
  });

  it('sum across multiple facts is correct (mixed action / claim / measurement)', async () => {
    mockApi([
      // 3 actions with samsung as subject (1 literal + 2 entity object).
      {
        fact_uid: 'a1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '발표',
        object_value: '메모리 단가 +35%',
        source_uids: ['s1'],
        fact_type: 'action',
      },
      {
        fact_uid: 'a2',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '발표',
        object_value: UID.HBM,
        object_label: 'HBM3E',
        object_entity_type: 'product',
        source_uids: ['s2'],
        fact_type: 'action',
      },
      {
        fact_uid: 'a3',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '경쟁',
        object_value: UID.TSMC,
        object_label: 'TSMC',
        object_entity_type: 'organization',
        source_uids: ['s3'],
        fact_type: 'action',
      },
      // 1 measurement on samsung.
      {
        fact_uid: 'm1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: 'has_metric',
        object_value: '53',
        source_uids: ['s4'],
        fact_type: 'measurement',
        metric: 'HBM 점유율',
        measurement_value: 53,
        measurement_unit: '%',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const samsung = data.nodes.find((n) => n.id === UID.SAMSUNG);
    expect(samsung?.fact_counts?.action).toBe(3);
    expect(samsung?.fact_counts?.claim).toBe(0);
    expect(samsung?.fact_counts?.measurement).toBe(1);
  });
});

describe('Renderer-facing pass-through (entity_type stays on the node)', () => {
  it('first fact decides entity_type, later facts do not overwrite a known type', async () => {
    mockApi([
      {
        fact_uid: 'f1',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        subject_entity_type: 'organization',
        predicate: '발표',
        object_value: UID.HBM,
        object_label: 'HBM',
        object_entity_type: 'product',
        source_uids: ['s1'],
        fact_type: 'action',
      },
      {
        fact_uid: 'f2',
        subject_uid: UID.SAMSUNG,
        subject_label: '삼성전자',
        predicate: '협력',
        object_value: UID.IROUNMALL,
        object_label: '이로운몰',
        object_entity_type: 'organization',
        source_uids: ['s2'],
        fact_type: 'action',
      },
    ]);
    const mod = await import('@/lib/stellarRealAdapter');
    const data = await mod.loadRealStellarGraph();
    const samsung = data.nodes.find((n) => n.id === UID.SAMSUNG);
    expect(samsung?.entity_type).toBe('organization');
  });
});
