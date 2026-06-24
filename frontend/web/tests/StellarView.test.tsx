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
  selectedId?: string | null;
  viewResetTick?: number;
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

  it('hover is a no-op (no floating tooltip); click opens the side fact panel', async () => {
    // stellar-zoom-recover — the floating HoverTooltip was removed
    // because it duplicated the FocusPanel info while the side panel
    // was open (the "2중 표시" PO repro). Hover still passes through
    // to the renderer's onNodeHover prop, but the parent treats it as
    // a no-op; only click → focus opens the side panel.
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    // Bind the callbacks must have been passed.
    expect(typeof lastRendererProps.current.onNodeHover).toBe('function');
    expect(typeof lastRendererProps.current.onNodeClick).toBe('function');

    // Simulate hover by clicking the mock "hover" button → no tooltip,
    // no side panel.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    expect(screen.queryByTestId('stellar-hover-tooltip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();

    // Simulate click → side panel opens.
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    await waitFor(() => expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument());
    // Still no floating tooltip even while a node is focused.
    expect(screen.queryByTestId('stellar-hover-tooltip')).not.toBeInTheDocument();
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

  // B-62-focus-select-actions — relation row click now selects without
  // re-centring; the user must hit 중심으로 to push history.
  it('back button pops focus history; disabled at the root', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    const back = screen.getByTestId('stellar-focus-back');
    expect(back.hasAttribute('disabled')).toBe(true);
    const firstRow = screen.getAllByTestId('stellar-focus-relation-row')[0]!;
    fireEvent.click(firstRow);
    // Focus did NOT change — relation row is a select, not a re-centre.
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    // Press 중심으로 to promote selected → new focus + history push.
    fireEvent.click(screen.getByTestId('stellar-focus-center'));
    expect(lastRendererProps.current.focusedId).toBe('fake-2');
    const backAfter = screen.getByTestId('stellar-focus-back');
    expect(backAfter.hasAttribute('disabled')).toBe(false);
    fireEvent.click(backAfter);
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
  });

  it('relation row click sets selected (NO focus change, NO history push)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    expect(lastRendererProps.current.selectedId).toBe('fake-1');
    const row = screen.getAllByTestId('stellar-focus-relation-row')[0]!;
    fireEvent.click(row);
    // Focus is the anchor; selected has moved.
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    expect(lastRendererProps.current.selectedId).toBe('fake-2');
    // Back is still disabled — no history was pushed.
    expect(screen.getByTestId('stellar-focus-back').hasAttribute('disabled')).toBe(true);
  });

  it('action footer appears only when selected differs from focused', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    // selected == focused on first canvas click → no footer.
    expect(screen.queryByTestId('stellar-focus-actions')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId('stellar-focus-relation-row')[0]!);
    // Now selected != focused → footer with 펼치기 + 중심으로 is up.
    expect(screen.getByTestId('stellar-focus-actions')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-focus-expand')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-focus-center')).toBeInTheDocument();
  });

  it('펼치기 keeps focus + selected but enlarges the neighbour set', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    const beforeNeighborSize =
      (lastRendererProps.current.focusedNeighborIds as Set<string>).size;
    fireEvent.click(screen.getAllByTestId('stellar-focus-relation-row')[0]!);
    fireEvent.click(screen.getByTestId('stellar-focus-expand'));
    // Focus + selected unchanged …
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    expect(lastRendererProps.current.selectedId).toBe('fake-2');
    // … and the highlight set grew (fake-2 + fake-2's neighbours added).
    const afterNeighborSize =
      (lastRendererProps.current.focusedNeighborIds as Set<string>).size;
    expect(afterNeighborSize).toBeGreaterThanOrEqual(beforeNeighborSize);
    expect(
      (lastRendererProps.current.focusedNeighborIds as Set<string>).has('fake-2'),
    ).toBe(true);
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

  // B-62-clear-focus-home-lookat — viewResetTick bumps on every
  // explicit "back to overview" event but stays stable while the
  // user is actively focusing nodes.
  it('viewResetTick stays at 0 through a focus + relation-row click', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    expect(lastRendererProps.current.viewResetTick ?? 0).toBe(0);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(lastRendererProps.current.viewResetTick ?? 0).toBe(0);
    fireEvent.click(screen.getAllByTestId('stellar-focus-relation-row')[0]!);
    expect(lastRendererProps.current.viewResetTick ?? 0).toBe(0);
  });

  it('× close button bumps viewResetTick (lookAt eases back to origin)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    const before = lastRendererProps.current.viewResetTick ?? 0;
    fireEvent.click(screen.getByTestId('stellar-drawer-close'));
    expect((lastRendererProps.current.viewResetTick ?? 0)).toBe(before + 1);
  });

  it('Esc bumps viewResetTick (lookAt eases back to origin)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    const before = lastRendererProps.current.viewResetTick ?? 0;
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect((lastRendererProps.current.viewResetTick ?? 0)).toBe(before + 1);
  });

  it('source toggle bumps viewResetTick (treated as back-to-overview)', async () => {
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
    const before = lastRendererProps.current.viewResetTick ?? 0;
    fireEvent.click(screen.getByTestId('stellar-source-real'));
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
    expect((lastRendererProps.current.viewResetTick ?? 0)).toBe(before + 1);
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

  // B-62-search-legibility — search bar tests.
  it('search input renders at top-left and is empty by default', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    const input = screen.getByTestId('stellar-search-input') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('');
    expect(screen.queryByTestId('stellar-search-results')).not.toBeInTheDocument();
  });

  it('search whitespace-only input is a no-op (no dropdown rendered)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    const input = screen.getByTestId('stellar-search-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByTestId('stellar-search-results')).not.toBeInTheDocument();
  });

  it('search matches against subject (case-insensitive substring)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    const input = screen.getByTestId('stellar-search-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '카네' } });
    expect(screen.getByTestId('stellar-search-results')).toBeInTheDocument();
    const rows = screen.getAllByTestId('stellar-search-result');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toContain('카네기멜론');
  });

  it('search result selection enters focus mode for the chosen node', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    const input = screen.getByTestId('stellar-search-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '서울대' } });
    const firstRow = screen.getAllByTestId('stellar-search-result')[0]!;
    fireEvent.mouseDown(firstRow);
    expect(lastRendererProps.current.focusedId).toBe('fake-2');
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
