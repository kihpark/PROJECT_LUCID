/**
 * B-62 — StellarView page-shell tests.
 *
 * jsdom can't render WebGL, so we mock the renderer via a prop override.
 * The component already accepts `renderer` + `realLoader` + `syntheticBuilder`
 * test seams; we use them here instead of vi.mock so the test stays close
 * to the production code path (toggle / hover / click / persistence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { StellarView } from '@/components/StellarView';
import type { StellarGraphData, StellarNode } from '@/lib/syntheticGraph';

// Capture the props the renderer is asked to display so tests can assert
// the wiring without ever touching three.js.
const lastRendererProps: { current: any } = { current: null };

function MockRenderer(props: {
  data: StellarGraphData;
  mode: 'synthetic' | 'real';
  onNodeHover?: (n: StellarNode | null) => void;
  onNodeClick?: (n: StellarNode) => void;
  focusedId?: string | null;
  focusedNeighborIds?: Set<string>;
}) {
  lastRendererProps.current = props;
  return (
    <div data-testid="mock-renderer" data-mode={props.mode}>
      <button
        type="button"
        data-testid="mock-fire-hover"
        onClick={() => props.onNodeHover?.(props.data.nodes[0] ?? null)}
      >
        hover
      </button>
      <button
        type="button"
        data-testid="mock-fire-click"
        onClick={() => props.onNodeClick?.(props.data.nodes[0] as StellarNode)}
      >
        click
      </button>
      <span data-testid="mock-node-count">{props.data.nodes.length}</span>
    </div>
  );
}

function fakeSyntheticBuilder(): StellarGraphData {
  return {
    nodes: [
      {
        id: 'fake-1',
        label: '카네기멜론 · AI 정렬',
        cluster: 0,
        weight: 4,
        x: 0,
        y: 0,
        z: 0,
        subject: '카네기멜론',
        predicate: 'supports',
        object: 'AI 정렬 연구',
      },
      {
        id: 'fake-2',
        label: '서울대 · 의사결정',
        cluster: 1,
        weight: 2,
        x: 10,
        y: 0,
        z: 0,
        subject: '서울대',
        predicate: 'is_examining',
        object: '의사결정 휴리스틱',
      },
    ],
    links: [{ source: 'fake-1', target: 'fake-2', type: 'supports' }],
    clusters: ['CMU', '서울대'],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  lastRendererProps.current = null;
});

describe('StellarView', () => {
  it('default mode is synthetic — aria-pressed reflects the active segment', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    const synth = screen.getByTestId('stellar-source-synthetic');
    const real = screen.getByTestId('stellar-source-real');
    expect(synth.getAttribute('aria-pressed')).toBe('true');
    expect(real.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('mock-renderer').getAttribute('data-mode')).toBe('synthetic');
  });

  it('clicking [real] flips mode and persists the choice to localStorage', async () => {
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [],
      links: [],
      clusters: [],
    } satisfies StellarGraphData);
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    const realBtn = screen.getByTestId('stellar-source-real');
    fireEvent.click(realBtn);
    expect(realBtn.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('lucid.stellar.source')).toBe('real');
    // The real loader is invoked on the source flip.
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
  });

  it('real mode renders the graph wrapper gracefully when adapter returns empty', async () => {
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [],
      links: [],
      clusters: [],
    } satisfies StellarGraphData);
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    fireEvent.click(screen.getByTestId('stellar-source-real'));
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
    // Cold-start hint is shown — but the renderer itself is still mounted
    // (so OrbitControls keep working when the user later switches back).
    await waitFor(() => expect(screen.getByTestId('stellar-empty-hint')).toBeInTheDocument());
    expect(screen.getByTestId('mock-renderer')).toBeInTheDocument();
  });

  it('hover callback opens the tooltip; click callback opens the fact drawer', async () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    // Bind the callbacks must have been passed.
    expect(typeof lastRendererProps.current.onNodeHover).toBe('function');
    expect(typeof lastRendererProps.current.onNodeClick).toBe('function');

    // Simulate hover by clicking the mock "hover" button.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    await waitFor(() => expect(screen.getByTestId('stellar-hover-tooltip')).toBeInTheDocument());

    // Simulate click → drawer opens.
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    await waitFor(() => expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument());
  });

  // B-62-v1 — focus mode tests.
  it('click → focus: renderer receives focusedId + neighbour set (1-hop)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    expect(lastRendererProps.current.focusedNeighborIds).toBeInstanceOf(Set);
    // fake-1 ↔ fake-2 in the seed link list.
    expect(lastRendererProps.current.focusedNeighborIds.has('fake-2')).toBe(true);
  });

  it('focus opens the panel with a relations list (clickable for chain-navigate)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument();
    const rows = screen.queryAllByTestId('stellar-focus-relation-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('back button pops focus history; disabled at the root', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    // No focus yet → no panel.
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();
    // First focus.
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    const back = screen.getByTestId('stellar-focus-back');
    expect(back.hasAttribute('disabled')).toBe(true); // no history yet
    // Chain-navigate: click the first relation row → push history.
    const firstRow = screen.getAllByTestId('stellar-focus-relation-row')[0]!;
    fireEvent.click(firstRow);
    expect(lastRendererProps.current.focusedId).toBe('fake-2');
    // Back button is now enabled.
    const backAfter = screen.getByTestId('stellar-focus-back');
    expect(backAfter.hasAttribute('disabled')).toBe(false);
    fireEvent.click(backAfter);
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
  });

  it('Esc clears focus entirely', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(lastRendererProps.current.focusedId).toBeNull();
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();
  });

  it('edge legend shows the 4 relation types in synthetic mode', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    expect(screen.getByTestId('stellar-edge-legend')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-edge-legend-supports')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-edge-legend-elaborates')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-edge-legend-causes')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-edge-legend-contradicts')).toBeInTheDocument();
  });

  it('source toggle resets focus + history (no stale focus across modes)', async () => {
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [],
      links: [],
      clusters: [],
    } satisfies StellarGraphData);
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    fireEvent.click(screen.getByTestId('stellar-source-real'));
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
    expect(lastRendererProps.current.focusedId).toBeNull();
  });

  it('honors persisted localStorage choice on next mount', async () => {
    window.localStorage.setItem('lucid.stellar.source', 'real');
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: 'r1',
          label: '실데이터 · 사실',
          cluster: 0,
          weight: 1,
          x: 0,
          y: 0,
          z: 0,
          subject: '주체',
          predicate: 'supports',
          object: '값',
        },
      ],
      links: [],
      clusters: ['실데이터'],
    } satisfies StellarGraphData);
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    await waitFor(() => {
      const real = screen.getByTestId('stellar-source-real');
      expect(real.getAttribute('aria-pressed')).toBe('true');
    });
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
  });
});
