/**
 * M3-2d StellarEntityCard tests.
 *
 * 노드 클릭 → entity 카드 (우패널). PO 의뢰서 verbatim.
 *   - entity 이름 + type 표시
 *   - fact 분류 (action / claim / measurement) 별 count
 *   - LEDGER / RECALL 딥링크
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  StellarEntityCard,
  countFactsByType,
  countFactsFromLinks,
} from '@/components/StellarEntityCard';
import type { StellarLink, StellarNode } from '@/lib/syntheticGraph';

function makeNode(overrides: Partial<StellarNode> = {}): StellarNode {
  return {
    id: 'n',
    label: 'L',
    cluster: 0,
    weight: 1,
    x: 0,
    y: 0,
    z: 0,
    subject: '한국은행',
    predicate: 'supports',
    object: 'X',
    ...overrides,
  };
}

describe('countFactsByType (pure helper)', () => {
  it('counts action / claim / measurement facts whose subject matches', () => {
    const entity = makeNode({ subject: '한국은행' });
    const facts: StellarNode[] = [
      makeNode({ id: 'a1', subject: '한국은행', fact_type: 'action' }),
      makeNode({ id: 'a2', subject: '한국은행', fact_type: 'action' }),
      makeNode({ id: 'c1', subject: '한국은행', fact_type: 'claim' }),
      makeNode({ id: 'm1', subject: '한국은행', fact_type: 'measurement' }),
      makeNode({ id: 'x1', subject: '다른곳', fact_type: 'action' }),
    ];
    const counts = countFactsByType(entity, facts);
    expect(counts.action).toBe(2);
    expect(counts.claim).toBe(1);
    expect(counts.measurement).toBe(1);
  });
});

describe('StellarEntityCard render', () => {
  it('renders entity name + type label', () => {
    const entity = makeNode({
      subject: '한국은행',
      subject_entity_type: 'organization',
    });
    render(
      <StellarEntityCard entity={entity} allFacts={[entity]} onClose={() => {}} />,
    );
    expect(screen.getByTestId('stellar-entity-card-name').textContent).toBe('한국은행');
    expect(screen.getByTestId('stellar-entity-card-type').textContent).toBe('organization');
  });

  it('shows fact counts by fact_type bucket', () => {
    const entity = makeNode({ subject: 'CMU' });
    const facts: StellarNode[] = [
      makeNode({ id: 'a1', subject: 'CMU', fact_type: 'action' }),
      makeNode({ id: 'c1', subject: 'CMU', fact_type: 'claim' }),
      makeNode({ id: 'c2', subject: 'CMU', fact_type: 'claim' }),
    ];
    render(
      <StellarEntityCard entity={entity} allFacts={facts} onClose={() => {}} />,
    );
    expect(screen.getByTestId('stellar-entity-card-count-action').textContent).toContain('1건');
    expect(screen.getByTestId('stellar-entity-card-count-claim').textContent).toContain('2건');
    expect(screen.getByTestId('stellar-entity-card-count-measurement').textContent).toContain('0건');
  });

  it('emits LEDGER + RECALL deep-link hrefs (★ U4 spec param keys)', () => {
    // fix/stellar-ux-self-audit U4 — deep-link param keys switched to the
    // spec form: `/ledger?entity_uid=<uid>` and `/recall?focus=<uid>` so the
    // contract is uniform across surfaces (PR brief / e2e / future routing).
    const entity = makeNode({
      subject: 'SpaceX',
      subject_uid: 'uid-spacex',
    });
    render(
      <StellarEntityCard entity={entity} allFacts={[entity]} onClose={() => {}} />,
    );
    const ledger = screen.getByTestId('stellar-entity-card-ledger-link');
    expect(ledger.getAttribute('href')).toBe('/ledger?entity_uid=uid-spacex');
    const recall = screen.getByTestId('stellar-entity-card-recall-link');
    // ★ legacy node (kind undefined) → falls back to subject_uid for focus.
    expect(recall.getAttribute('href')).toBe('/recall?focus=uid-spacex');
  });

  it('renders a placeholder for the next-step merge/unmerge surface', () => {
    const entity = makeNode();
    render(
      <StellarEntityCard entity={entity} allFacts={[entity]} onClose={() => {}} />,
    );
    expect(
      screen.getByTestId('stellar-entity-card-merge-placeholder').textContent,
    ).toContain('수동 통합/분리');
  });

  // fix/terminology-unify-balhwa-balhweon — 용어 통일 보존 가드.
  // CLAIM fact 카운트 라벨은 '발언 fact' 로 표기한다 (★ '발화' X).
  it('CLAIM fact bucket label reads 발언 fact (not 발화)', () => {
    const entity = makeNode({ subject: '한국은행' });
    const facts: StellarNode[] = [
      makeNode({ id: 'c1', subject: '한국은행', fact_type: 'claim' }),
    ];
    render(
      <StellarEntityCard entity={entity} allFacts={facts} onClose={() => {}} />,
    );
    const row = screen.getByTestId('stellar-entity-card-count-claim');
    expect(row.textContent).toContain('발언');
    expect(row.textContent).not.toContain('발화');
  });

  it('close button fires onClose', () => {
    const entity = makeNode();
    const onClose = vi.fn();
    render(
      <StellarEntityCard entity={entity} allFacts={[entity]} onClose={onClose} />,
    );
    screen.getByTestId('stellar-entity-card-close').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// fix/stellar-cards-entity-node-compat (2026-06-29) — v2 entity-node + links.
describe('v2 entity-node + links (★ fix/stellar-cards-entity-node-compat)', () => {
  function makeEntity(overrides: Partial<StellarNode> = {}): StellarNode {
    return {
      id: 'uid-a',
      label: '강재호',
      cluster: 0,
      weight: 1,
      kind: 'entity',
      entity_type: 'person',
      subject: undefined,
      predicate: undefined,
      object: undefined,
      ...overrides,
    };
  }

  function makeLink(overrides: Partial<StellarLink> = {}): StellarLink {
    return {
      source: 'uid-a',
      target: 'uid-b',
      kind: 'action',
      fact_count: 1,
      ...overrides,
    };
  }

  it('counts action / claim / measurement from links + entity.measurements', () => {
    const entity = makeEntity({
      id: 'uid-a',
      measurements: [],
    });
    const links: StellarLink[] = [
      makeLink({ source: 'uid-a', target: 'uid-b', kind: 'action', fact_count: 2 }),
      makeLink({ source: 'uid-b', target: 'uid-a', kind: 'action', fact_count: 1 }),
      makeLink({ source: 'uid-a', target: 'claim-1', kind: 'speaker', fact_count: 1 }),
    ];
    const counts = countFactsFromLinks(entity, links);
    expect(counts.action).toBe(3);
    expect(counts.claim).toBe(1);
    expect(counts.measurement).toBe(0);
  });

  it('renders entity name + type + link-derived counts', () => {
    const entity = makeEntity({ id: 'uid-a', label: '강재호', entity_type: 'person' });
    const links: StellarLink[] = [
      makeLink({ source: 'uid-a', target: 'uid-b', kind: 'action', fact_count: 2 }),
      makeLink({ source: 'uid-b', target: 'uid-a', kind: 'action', fact_count: 1 }),
      makeLink({ source: 'uid-a', target: 'claim-1', kind: 'speaker', fact_count: 1 }),
    ];
    const { container } = render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={links}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('stellar-entity-card-name').textContent).toBe('강재호');
    expect(screen.getByTestId('stellar-entity-card-type').textContent).toBe('person');
    expect(screen.getByTestId('stellar-entity-card-count-action').textContent).toContain(
      '3건',
    );
    expect(screen.getByTestId('stellar-entity-card-count-claim').textContent).toContain(
      '1건',
    );
    expect(
      screen.getByTestId('stellar-entity-card-count-measurement').textContent,
    ).toContain('0건');
    // ★ regression guard.
    expect(container.textContent ?? '').not.toContain('(주체 없음)');
  });

  it('LEDGER href uses entity.id when kind === "entity" (★ U4 entity_uid)', () => {
    // fix/stellar-ux-self-audit U4 — spec form `entity_uid=<uid>`.
    const entity = makeEntity({ id: 'uid-a' });
    render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={[]}
        onClose={() => {}}
      />,
    );
    const ledger = screen.getByTestId('stellar-entity-card-ledger-link');
    expect(ledger.getAttribute('href')).toBe('/ledger?entity_uid=uid-a');
    // RECALL also uses focus=<uid>; tested in the U4 deeplink contract above.
    const recall = screen.getByTestId('stellar-entity-card-recall-link');
    expect(recall.getAttribute('href')).toBe('/recall?focus=uid-a');
  });

  it('★ regression guard: "(주체 없음)" 노출 0 in v2 entity card', () => {
    const entity = makeEntity({
      id: 'uid-empty',
      label: '',
      subject: undefined,
    });
    const { container } = render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={[]}
        onClose={() => {}}
      />,
    );
    expect(container.textContent ?? '').not.toContain('(주체 없음)');
  });
});

// ★ fix/entitycard-fact-count-and-dot-suggestion — PO live report: 강재호
// hover 에서 행동/발언/수치/연결이 전부 0 으로 나옴. 그러나 강재호 는 ACTION
// fact 1 건 (object 가 literal "이로운몰 설립") 의 subject 이므로 행동 1 이
// 맞다. link 수 ≠ fact 수. entity.fact_counts 가 link 와 무관하게 누적된다.
describe('fact_counts (★ fix/entitycard-fact-count-and-dot-suggestion)', () => {
  function makeEntity(overrides: Partial<StellarNode> = {}): StellarNode {
    return {
      id: 'uid-kang',
      label: '강재호',
      cluster: 0,
      weight: 1,
      kind: 'entity',
      entity_type: 'person',
      ...overrides,
    };
  }

  it('★ 강재호 시나리오: links=[] but fact_counts.action=1 → "1건" rendered', () => {
    const entity = makeEntity({
      fact_counts: { action: 1, claim: 0, measurement: 0 },
    });
    render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={[]}
        onClose={() => {}}
      />,
    );
    // ★ link count 0 + fact count 1.
    expect(
      screen.getByTestId('stellar-entity-card-count-action').textContent,
    ).toContain('1건');
    expect(
      screen.getByTestId('stellar-entity-card-count-claim').textContent,
    ).toContain('0건');
    expect(
      screen.getByTestId('stellar-entity-card-count-measurement').textContent,
    ).toContain('0건');
  });

  it('fact_counts.claim = 3 → "3건" in 발언 row', () => {
    const entity = makeEntity({
      fact_counts: { action: 0, claim: 3, measurement: 0 },
    });
    render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={[]}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByTestId('stellar-entity-card-count-claim').textContent,
    ).toContain('3건');
  });

  it('fact_counts.measurement = 2 → "2건" in 수치 row', () => {
    const entity = makeEntity({
      fact_counts: { action: 0, claim: 0, measurement: 2 },
    });
    render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={[]}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByTestId('stellar-entity-card-count-measurement').textContent,
    ).toContain('2건');
  });

  it('fact_counts absent → falls back to countFactsFromLinks (link path still works)', () => {
    // Regression: when fact_counts is undefined, v2 link-derived path still
    // operates so existing entity-node graphs render the same as before.
    const entity = makeEntity({ fact_counts: undefined });
    const links: StellarLink[] = [
      { source: 'uid-kang', target: 'uid-b', kind: 'action', fact_count: 2 },
    ];
    render(
      <StellarEntityCard
        entity={entity}
        allFacts={[]}
        links={links}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByTestId('stellar-entity-card-count-action').textContent,
    ).toContain('2건');
  });
});

// ★ V3a (STELLAR 발언 full context 위반 클래스, 2026-06-29) — claim 노드 분기.
describe('claim node branch (★ V3 — STELLAR 발언 full context)', () => {
  function makeClaim(overrides: Partial<StellarNode> = {}): StellarNode {
    return {
      id: 'claim-X',
      label: '',
      cluster: 0,
      weight: 1,
      kind: 'claim',
      speaker_label: 'A',
      speech_act: 'assertion',
      content_claim: 'X',
      subject: undefined,
      predicate: undefined,
      object: undefined,
      ...overrides,
    };
  }

  it('claim node renders SPEAKER + full content (★ no truncation)', () => {
    const longText = 'X'.repeat(300);
    const fact = makeClaim({
      content_claim: longText,
      speaker_label: 'A',
    });
    render(
      <StellarEntityCard entity={fact} allFacts={[]} onClose={() => {}} />,
    );
    const content = screen.getByTestId('stellar-entity-card-claim-content');
    expect(content.textContent ?? '').toContain(longText);
    // The speaker line uses speaker_label.
    expect(
      screen.getByTestId('stellar-entity-card-claim-speaker').textContent,
    ).toBe('A');
  });

  it('claim card shows RECALL (focus=<id>) + LEDGER (fact=<id>) deep links', () => {
    // fix/stellar-ux-self-audit U4 — claim 노드도 RECALL 은 `focus=<fact_uid>`.
    // LEDGER 는 fact-scoped page 이므로 `fact=<fact_uid>` 유지.
    const longText = 'Q'.repeat(220);
    const fact = makeClaim({
      id: 'claim-uid-1',
      content_claim: longText,
    });
    render(
      <StellarEntityCard entity={fact} allFacts={[]} onClose={() => {}} />,
    );
    const recall = screen.getByTestId('stellar-entity-card-claim-recall-link');
    expect(recall.getAttribute('href')).toBe(
      `/recall?focus=${encodeURIComponent('claim-uid-1')}`,
    );
    const ledger = screen.getByTestId('stellar-entity-card-claim-ledger-link');
    expect(ledger.getAttribute('href')).toBe(`/ledger?fact=${encodeURIComponent('claim-uid-1')}`);
  });

  it('claim card root carries data-testid="stellar-entity-card-claim"', () => {
    const fact = makeClaim();
    render(
      <StellarEntityCard entity={fact} allFacts={[]} onClose={() => {}} />,
    );
    expect(screen.getByTestId('stellar-entity-card-claim')).toBeTruthy();
  });

  it('claim card does NOT render the entity-fact-counts block', () => {
    const fact = makeClaim();
    render(
      <StellarEntityCard entity={fact} allFacts={[]} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('stellar-entity-card-counts')).toBeNull();
  });
});
