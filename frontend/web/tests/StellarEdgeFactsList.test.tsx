/**
 * M3-2d StellarEdgeFactsList tests.
 *
 * 엣지 클릭 → fact 리스트 (우패널). 각 fact: 원문 + SPO + as_of + provenance.
 *
 * ★ PO 정정 가드: link_status 시각 unbind 검증 — link_status 값이
 *   바뀌어도 row 의 stroke / 색 / opacity 어떤 시각 attribute 도
 *   영향을 받지 않는다.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  StellarEdgeFactsList,
  findFactsForEdge,
} from '@/components/StellarEdgeFactsList';
import { edgeStyle, edgeStyleIgnoringLinkStatus } from '@/lib/stellarEdgeStyle';
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
    subject: 'S',
    predicate: 'supports',
    object: 'O',
    ...overrides,
  };
}

describe('findFactsForEdge (pure helper)', () => {
  it('returns facts with the matching SPO endpoint pair', () => {
    const a = makeNode({ id: 'A', subject: 'A' });
    const b = makeNode({ id: 'B', subject: 'B' });
    const facts: StellarNode[] = [
      makeNode({ id: 'f1', subject: 'A', object: 'B' }),
      makeNode({ id: 'f2', subject: 'B', object: 'A' }),
      makeNode({ id: 'f3', subject: 'A', object: 'C' }),
    ];
    const found = findFactsForEdge(a, b, facts);
    expect(found.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
  });
});

describe('StellarEdgeFactsList render', () => {
  it('엣지 클릭 → fact 리스트 (각 fact 의 SPO + as_of + provenance)', () => {
    const a = makeNode({ id: 'A', subject: 'A' });
    const b = makeNode({ id: 'B', subject: 'B' });
    const facts: StellarNode[] = [
      makeNode({
        id: 'f1',
        subject: 'A',
        object: 'B',
        predicate: 'supports',
        surface_text: 'A 가 B 를 뒷받침한다.',
        as_of: '2026-05',
        source_url: 'https://example.com/article',
        extracted_at: '2026-05-12T10:00:00Z',
      }),
    ];
    render(
      <StellarEdgeFactsList
        endpoints={{ a, b }}
        allFacts={facts}
        onClose={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('stellar-edge-facts-row');
    expect(rows.length).toBe(1);
    // 원문 (surface text)
    expect(screen.getByTestId('stellar-edge-facts-row-surface').textContent).toContain(
      'A 가 B 를 뒷받침한다.',
    );
    // SPO
    const spo = screen.getByTestId('stellar-edge-facts-row-spo').textContent ?? '';
    expect(spo).toContain('A');
    expect(spo).toContain('B');
    // as_of
    expect(screen.getByTestId('stellar-edge-facts-row-asof').textContent).toContain('2026-05');
    // provenance (source url + extracted_at)
    const src = screen.getByTestId('stellar-edge-facts-row-source');
    expect(src.getAttribute('href')).toBe('https://example.com/article');
    expect(screen.getByTestId('stellar-edge-facts-row-extracted').textContent).toContain('2026-05-12');
  });

  it('empty list — endpoints with no facts in between', () => {
    const a = makeNode({ id: 'A', subject: 'A' });
    const b = makeNode({ id: 'B', subject: 'B' });
    render(
      <StellarEdgeFactsList endpoints={{ a, b }} allFacts={[]} onClose={() => {}} />,
    );
    expect(screen.getByTestId('stellar-edge-facts-empty')).toBeInTheDocument();
  });

  // ★ PO 정정 가드 — link_status 시각 unbind.
  it('★ link_status 시각 unbind: verified vs claimed 같은 row visual', () => {
    // Pure-side gate via edgeStyle helper: both inputs must produce identical
    // style. This is the load-bearing assertion for the data-only contract.
    const verified = edgeStyleIgnoringLinkStatus('action', 5, 'verified');
    const claimed = edgeStyleIgnoringLinkStatus('action', 5, 'claimed');
    expect(verified).toEqual(claimed);
    // The non-status helper is also identical (sanity).
    const baseline = edgeStyle('action', 5);
    expect(verified).toEqual(baseline);

    // Component side: link_status appears as a TEXT label only, never bound
    // to row stroke / color / opacity attributes.
    const a = makeNode({ id: 'A', subject: 'A' });
    const b = makeNode({ id: 'B', subject: 'B' });
    const factVerified = makeNode({
      id: 'fv',
      subject: 'A',
      object: 'B',
      link_status: 'verified',
    });
    const factClaimed = makeNode({
      id: 'fc',
      subject: 'A',
      object: 'B',
      link_status: 'claimed',
    });
    const { unmount } = render(
      <StellarEdgeFactsList
        endpoints={{ a, b }}
        allFacts={[factVerified]}
        onClose={() => {}}
      />,
    );
    const rowV = screen.getByTestId('stellar-edge-facts-row');
    const styleV = rowV.getAttribute('style') ?? '';
    const labelV = screen.getByTestId('stellar-edge-facts-row-link-status');
    expect(labelV.getAttribute('data-link-status')).toBe('verified');
    unmount();

    render(
      <StellarEdgeFactsList
        endpoints={{ a, b }}
        allFacts={[factClaimed]}
        onClose={() => {}}
      />,
    );
    const rowC = screen.getByTestId('stellar-edge-facts-row');
    const styleC = rowC.getAttribute('style') ?? '';
    const labelC = screen.getByTestId('stellar-edge-facts-row-link-status');
    expect(labelC.getAttribute('data-link-status')).toBe('claimed');
    // ★ Row inline style must be identical — link_status drives ONLY the
    //   text label, NEVER any visual attribute.
    expect(styleV).toBe(styleC);
  });

  it('close button fires onClose', () => {
    const a = makeNode({ id: 'A', subject: 'A' });
    const b = makeNode({ id: 'B', subject: 'B' });
    const onClose = vi.fn();
    render(
      <StellarEdgeFactsList endpoints={{ a, b }} allFacts={[]} onClose={onClose} />,
    );
    screen.getByTestId('stellar-edge-facts-close').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
