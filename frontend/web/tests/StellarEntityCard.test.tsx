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
} from '@/components/StellarEntityCard';
import type { StellarNode } from '@/lib/syntheticGraph';

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

  it('emits LEDGER + RECALL deep-link hrefs', () => {
    const entity = makeNode({
      subject: 'SpaceX',
      subject_uid: 'uid-spacex',
    });
    render(
      <StellarEntityCard entity={entity} allFacts={[entity]} onClose={() => {}} />,
    );
    const ledger = screen.getByTestId('stellar-entity-card-ledger-link');
    expect(ledger.getAttribute('href')).toBe('/ledger?entity=uid-spacex');
    const recall = screen.getByTestId('stellar-entity-card-recall-link');
    expect(recall.getAttribute('href')).toBe('/recall?q=SpaceX');
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
