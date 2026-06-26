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

// feat/hearth-oracle-merge — StellarView now reads ?cluster= from
// next/navigation. We mock useSearchParams so tests can drive the
// auto-focus behaviour (default: no cluster param, no auto-focus).
const searchParamsRef = { current: new URLSearchParams() as URLSearchParams };
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsRef.current,
}));

import { StellarView, predicateThemeColor, pickClusterFocusNode } from '@/components/StellarView';
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
  // fix/stellar-cluster-focus-race-fix — pre-set the v2 migration marker
  // so each test starts in a predictable state. Without this, the lazy
  // init in StellarView would clear localStorage on the first read of
  // every test (the migration is one-shot per browser session), making
  // it impossible for tests to set `lucid.stellar.source` and have it
  // honored. Tests that explicitly want to exercise the migration path
  // delete both keys first.
  window.localStorage.setItem('lucid.stellar.source:migrated:v2', '1');
  // fix/stellar-cluster-focus-race-fix — default tests to synthetic mode.
  // Most test scenarios assert against the fakeSyntheticBuilder data
  // (fake-1 / fake-2). Production default is now 'real' (StellarView
  // seeds source synchronously from localStorage on mount), so without
  // an explicit synthetic seed the renderer would receive an empty real
  // graph and every fake-1/fake-2 assertion would break. Tests that
  // need to exercise real-mode defaults override this seed locally.
  window.localStorage.setItem('lucid.stellar.source', 'synthetic');
  lastRendererProps.current = null;
  searchParamsRef.current = new URLSearchParams();
});

describe('StellarView', () => {
  it('default mode (first visit, no localStorage) is real — synced sync from localStorage', () => {
    // fix/stellar-cluster-focus-race-fix — the previous default was a
    // stale one-frame 'synthetic' from useState('synthetic'); the post-
    // mount effect then flipped to real. That stale frame is what
    // latched syn-3-100 into focus before real data arrived. We now
    // seed source synchronously from localStorage; first visit (no LS
    // entry) returns 'real' per readPersistedSource fallback.
    window.localStorage.removeItem('lucid.stellar.source');
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [], links: [], clusters: [],
    } satisfies StellarGraphData);
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    const synth = screen.getByTestId('stellar-source-synthetic');
    const real = screen.getByTestId('stellar-source-real');
    expect(synth.getAttribute('aria-pressed')).toBe('false');
    expect(real.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('mock-renderer').getAttribute('data-mode')).toBe('real');
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

  it('hover renders a floating tooltip; click opens the side fact panel (coexist)', async () => {
    // feat/stellar-hover-restore-by-type — hover is BACK but is now a
    // lightweight preview that branches on fact_type. The side panel
    // stays the click surface; both can render at once (peek + read).
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    expect(typeof lastRendererProps.current.onNodeHover).toBe('function');
    expect(typeof lastRendererProps.current.onNodeClick).toBe('function');

    // Default state — no tooltip, no side panel.
    expect(screen.queryByTestId('stellar-hover-tooltip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();

    // Hover fake-1 (action by default) → tooltip up.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = await screen.findByTestId('stellar-hover-tooltip');
    expect(tip).toBeInTheDocument();
    expect(tip.getAttribute('data-fact-type')).toBe('action');

    // Click → side panel opens, tooltip still allowed to stay (coexist).
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    await waitFor(() => expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument());
    expect(screen.getByTestId('stellar-hover-tooltip')).toBeInTheDocument();
  });

  it('hover tooltip — ACTION fact: subject → predicate(KO) → object', () => {
    function actionBuilder(): StellarGraphData {
      return {
        nodes: [
          {
            id: 'a-1',
            label: '한국은행 · 환율 변동성',
            cluster: 0,
            weight: 3,
            x: 0,
            y: 0,
            z: 0,
            subject: '한국은행',
            predicate: 'is_examining',
            object: '환율 변동성',
            fact_type: 'action',
          },
        ],
        links: [],
        clusters: ['금융'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={actionBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = screen.getByTestId('stellar-hover-tooltip');
    expect(tip.getAttribute('data-fact-type')).toBe('action');
    expect(screen.getByTestId('stellar-hover-tooltip-head').textContent).toBe('한국은행');
    // predicate 'is_examining' maps to '검토 중인 것은' via predicateLabel.
    expect(screen.getByTestId('stellar-hover-tooltip-mid').textContent).toContain('→');
    expect(screen.getByTestId('stellar-hover-tooltip-mid').textContent).toContain('검토 중인 것은');
    expect(screen.getByTestId('stellar-hover-tooltip-body').textContent).toBe('환율 변동성');
    // Action has no footer (only measurement uses it).
    expect(screen.queryByTestId('stellar-hover-tooltip-foot')).not.toBeInTheDocument();
  });

  it('hover tooltip — CLAIM fact: speaker [speech_act]: content', () => {
    function claimBuilder(): StellarGraphData {
      return {
        nodes: [
          {
            id: 'c-1',
            label: '한국은행 발언',
            cluster: 0,
            weight: 1,
            x: 0,
            y: 0,
            z: 0,
            subject: '한국은행',
            predicate: 'states',
            object: '환율 변동성 상승 가능성',
            fact_type: 'claim',
            speaker_label: '한국은행',
            speech_act: '발표했다',
            content_claim: '환율 변동성 상승 가능성',
          },
        ],
        links: [],
        clusters: ['금융'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={claimBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = screen.getByTestId('stellar-hover-tooltip');
    expect(tip.getAttribute('data-fact-type')).toBe('claim');
    // Speaker on the head, bracketed speech_act on the mid, content on the body.
    expect(screen.getByTestId('stellar-hover-tooltip-head').textContent).toBe('한국은행');
    expect(screen.getByTestId('stellar-hover-tooltip-mid').textContent).toBe('[발표했다]');
    expect(screen.getByTestId('stellar-hover-tooltip-body').textContent).toBe(
      '환율 변동성 상승 가능성',
    );
    expect(screen.queryByTestId('stellar-hover-tooltip-foot')).not.toBeInTheDocument();
  });

  it('hover tooltip — MEASUREMENT fact: metric = value unit (as_of footer)', () => {
    function measurementBuilder(): StellarGraphData {
      return {
        nodes: [
          {
            id: 'm-1',
            label: 'MAU = 8억',
            cluster: 0,
            weight: 1,
            x: 0,
            y: 0,
            z: 0,
            subject: 'Meta',
            predicate: 'has_metric',
            object: '8억 명',
            fact_type: 'measurement',
            metric: 'MAU',
            measurement_value: 800_000_000,
            measurement_unit: '명',
            as_of: '2026-03',
          },
        ],
        links: [],
        clusters: ['빅테크'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={measurementBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = screen.getByTestId('stellar-hover-tooltip');
    expect(tip.getAttribute('data-fact-type')).toBe('measurement');
    expect(screen.getByTestId('stellar-hover-tooltip-head').textContent).toBe('MAU');
    expect(screen.getByTestId('stellar-hover-tooltip-mid').textContent).toBe('=');
    expect(screen.getByTestId('stellar-hover-tooltip-body').textContent).toBe('800000000 명');
    // Measurement IS the only shape with a footer (as_of).
    expect(screen.getByTestId('stellar-hover-tooltip-foot').textContent).toBe('2026-03');
  });

  it('hover tooltip + side panel can coexist (hover = peek, click = read)', async () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    await waitFor(() => expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument());
    // Hover ALSO emits a tooltip while the side panel is open.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    expect(screen.getByTestId('stellar-hover-tooltip')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument();
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

  // -------------------------------------------------------------------------
  // feat/hearth-oracle-merge — /stellar?cluster=<value> auto-focus (H-5)
  // -------------------------------------------------------------------------

  it('H-5 — ?cluster=most_active auto-focuses the highest-degree cluster node', async () => {
    searchParamsRef.current = new URLSearchParams('cluster=most_active');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
      />,
    );
    // Auto-focus runs after activeData lands.
    await waitFor(() => {
      const focusedId = lastRendererProps.current.focusedId;
      expect(focusedId).toBeTruthy();
      // fake builder returns two nodes — one of them must be focused.
      expect(['fake-1', 'fake-2']).toContain(focusedId);
    });
    // FocusPanel mounts when focused is set.
    await waitFor(() => {
      expect(screen.getByTestId('stellar-fact-drawer')).toBeInTheDocument();
    });
  });

  it('H-5 — ?cluster=<exact-id> auto-focuses that specific node', async () => {
    searchParamsRef.current = new URLSearchParams('cluster=fake-2');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
      />,
    );
    await waitFor(() => {
      expect(lastRendererProps.current.focusedId).toBe('fake-2');
    });
  });

  it('H-5 — no ?cluster param → no auto-focus (manual exploration default)', async () => {
    searchParamsRef.current = new URLSearchParams();
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
      />,
    );
    // Give effects a tick to settle.
    await act(async () => { await Promise.resolve(); });
    expect(lastRendererProps.current.focusedId).toBeFalsy();
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();
  });

  it('H-5 — cluster=<unknown_uid> falls back to most_active path', async () => {
    searchParamsRef.current = new URLSearchParams('cluster=unknown-uid-xyz-9999');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
      />,
    );
    // The unknown id misses both id+label match → falls back to
    // most_active picker, which returns SOME node from the seed.
    await waitFor(() => {
      const focusedId = lastRendererProps.current.focusedId;
      expect(focusedId).toBeTruthy();
      expect(['fake-1', 'fake-2']).toContain(focusedId);
    });
  });

  it('H-5 — cluster=most_active focuses when source localStorage hint matches available data (synthetic)', async () => {
    // PO scenario: explicit ?cluster= URL in synthetic mode. Default
    // beforeEach seeds 'synthetic' so we test against the synthetic
    // builder data directly without any real loader involvement.
    expect(window.localStorage.getItem('lucid.stellar.source')).toBe('synthetic');
    searchParamsRef.current = new URLSearchParams('cluster=most_active');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
      />,
    );
    await waitFor(() => {
      expect(lastRendererProps.current.focusedId).toBeTruthy();
    });
  });

  it('H-5 — empty synthetic builder + cluster=most_active does NOT crash', async () => {
    function emptyBuilder(): StellarGraphData {
      return { nodes: [], links: [], clusters: [] };
    }
    searchParamsRef.current = new URLSearchParams('cluster=most_active');
    render(
      <StellarView renderer={MockRenderer} syntheticBuilder={emptyBuilder} />,
    );
    // Give effects a tick. Auto-focus bails on empty graph, no crash.
    await act(async () => { await Promise.resolve(); });
    expect(lastRendererProps.current.focusedId).toBeFalsy();
    expect(screen.queryByTestId('stellar-fact-drawer')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // fix/stellar-cleanup #9 — predicate theme color drives the SPO card accent.
  // -------------------------------------------------------------------------

  describe('predicateThemeColor', () => {
    it('returns teal for concord predicates', () => {
      expect(predicateThemeColor('is_consistent_with')).toBe('#4FD1C5');
      expect(predicateThemeColor('supports')).toBe('#4FD1C5');
      expect(predicateThemeColor('confirms')).toBe('#4FD1C5');
    });

    it('returns soft red for discord predicates', () => {
      expect(predicateThemeColor('contradicts')).toBe('#f06a78');
      expect(predicateThemeColor('refutes')).toBe('#f06a78');
      expect(predicateThemeColor('disputes')).toBe('#f06a78');
    });

    it('returns amber for causal predicates', () => {
      expect(predicateThemeColor('causes')).toBe('#f5b95c');
      expect(predicateThemeColor('triggers')).toBe('#f5b95c');
    });

    it('returns cyan for informational predicates', () => {
      expect(predicateThemeColor('elaborates')).toBe('#39d3ec');
      expect(predicateThemeColor('is_examining')).toBe('#39d3ec');
      expect(predicateThemeColor('states')).toBe('#39d3ec');
    });

    it('returns muted neutral for unknown predicates', () => {
      expect(predicateThemeColor('weird_predicate_xyz')).toBe('#9db0b5');
      expect(predicateThemeColor(null)).toBe('#9db0b5');
      expect(predicateThemeColor('')).toBe('#9db0b5');
    });
  });

  it('#9 — hover SPO card carries a theme color matched to predicate', () => {
    function discordBuilder(): StellarGraphData {
      return {
        nodes: [
          {
            id: 'd-1',
            label: '한국은행 · 미국 연준',
            cluster: 0,
            weight: 2,
            x: 0,
            y: 0,
            z: 0,
            subject: '한국은행',
            predicate: 'contradicts',
            object: '미국 연준',
            fact_type: 'action',
          },
        ],
        links: [],
        clusters: ['금융'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={discordBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = screen.getByTestId('stellar-hover-tooltip');
    expect(tip.getAttribute('data-theme-color')).toBe('#f06a78');
  });

  it('#9 — concord predicate gets the teal accent', () => {
    function concordBuilder(): StellarGraphData {
      return {
        nodes: [
          {
            id: 'k-1',
            label: '제임스 한센 · +1.5℃ 시나리오',
            cluster: 0,
            weight: 2,
            x: 0,
            y: 0,
            z: 0,
            subject: '제임스 한센',
            predicate: 'is_consistent_with',
            object: '+1.5℃ 시나리오',
            fact_type: 'action',
          },
        ],
        links: [],
        clusters: ['기후'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={concordBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = screen.getByTestId('stellar-hover-tooltip');
    expect(tip.getAttribute('data-theme-color')).toBe('#4FD1C5');
  });

  it('#10 — cluster=most_active waits for real data when localStorage prefers real (PO 2026-06-26: no stale syn-* focus)', async () => {
    // fix/stellar-cluster-focus-race-fix — the PREVIOUS behavior
    // (recover) latched on synthetic data immediately, then the real
    // graph loaded and `focused` held a stale synthetic node id —
    // StellarGraph.fly-to logged 'focused node not in data' for
    // syn-3-100 and the FocusPanel kept showing the synthetic IPCC
    // sample. PO repro on 2026-06-26 caught exactly this.
    //
    // New contract: when localStorage prefers real, the auto-focus
    // waits for the real loader to settle BEFORE binding. Synthetic
    // data is never used to pre-fill `focused` for a real-mode user.
    // The id we end on must come from the real graph; the synthetic
    // ids (fake-*) must NEVER appear in focusedId for this scenario.
    searchParamsRef.current = new URLSearchParams('cluster=most_active');
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: 'r1',
          label: 'A · X',
          cluster: 0,
          weight: 1,
          degree: 1,
          x: 0, y: 0, z: 0,
          subject: 'A', predicate: 'supports', object: 'X',
        },
        {
          id: 'r2',
          label: 'B · Y',
          cluster: 1,
          weight: 5,
          degree: 5,
          x: 0, y: 0, z: 0,
          subject: 'B', predicate: 'supports', object: 'Y',
        },
      ],
      links: [],
      clusters: ['c0', 'c1'],
    } satisfies StellarGraphData);
    window.localStorage.setItem('lucid.stellar.source', 'real');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    await waitFor(() => {
      const focusedId = lastRendererProps.current.focusedId;
      expect(focusedId).toBeTruthy();
      // r2 wins the most-active fallback (highest degree). Critically
      // 'fake-1' / 'fake-2' MUST NOT appear — that would be the bug.
      expect(focusedId).toBe('r2');
    });
    expect(['fake-1', 'fake-2']).not.toContain(lastRendererProps.current.focusedId);
  });

  // fix/stellar-cluster-focus-race-fix — explicit regression tests.
  it('regression: cluster focus never latches a synthetic id when localStorage prefers real (the PO syn-3-100 bug)', async () => {
    // Reproduces the exact PO 2026-06-26 sequence:
    //   1. localStorage = 'real' (user previously toggled to real).
    //   2. URL has ?cluster=<entity_uid>.
    //   3. Synthetic generator is the production one (provides syn-*
    //      ids on first render).
    //   4. Real loader is intentionally slow so the synthetic data is
    //      the only thing available for a long window.
    // BEFORE the fix: cluster-focus useEffect latched on syn-3-100,
    // then 'focused' kept the stale id when real arrived.
    // AFTER the fix: useEffect WAITS for real to finish before
    // binding. The slow window goes by with focusedId=null.
    const ENTITY = '8e68baf5-97b1-4833-9604-a6b5dd99ec7b';
    searchParamsRef.current = new URLSearchParams(`cluster=${ENTITY}`);
    window.localStorage.setItem('lucid.stellar.source', 'real');
    let resolveLoader: (data: StellarGraphData) => void = () => {};
    const loaderPromise = new Promise<StellarGraphData>((res) => {
      resolveLoader = res;
    });
    const realLoader = vi.fn().mockReturnValue(loaderPromise);
    function syntheticHasSynIds(): StellarGraphData {
      return {
        nodes: [
          // Mimics the production generator's `syn-c-i` shape.
          {
            id: 'syn-3-100',
            label: 'IPCC · +1.5℃',
            cluster: 3,
            weight: 9,
            degree: 12,
            x: 0, y: 0, z: 0,
            subject: 'IPCC',
            predicate: 'supports',
            object: '+1.5℃ 시나리오',
          },
        ],
        links: [],
        clusters: ['climate'],
      };
    }
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={syntheticHasSynIds}
        realLoader={realLoader}
      />,
    );
    // Before the loader resolves, focus must NOT have latched syn-3-100.
    await act(async () => { await Promise.resolve(); });
    expect(lastRendererProps.current.focusedId).not.toBe('syn-3-100');
    // Resolve the loader with a real graph that DOES have a match.
    await act(async () => {
      resolveLoader({
        nodes: [
          {
            id: 'real-spine',
            label: 'spine',
            cluster: 0,
            weight: 1,
            degree: 12,
            x: 0, y: 0, z: 0,
            subject: '모스 탄', predicate: 'states', object: 'X',
            subject_uid: ENTITY,
          },
        ],
        links: [],
        clusters: ['c0'],
      });
    });
    await waitFor(() => {
      expect(lastRendererProps.current.focusedId).toBe('real-spine');
    });
  });

  it('regression: source toggle clears stale focus + re-fires cluster auto-focus latch', async () => {
    // When the user (or the migration path) flips source AFTER an
    // initial cluster auto-focus has been bound, the focused node id
    // belongs to the old data. Without the source-change effect that
    // resets `focused` and `clusterAutoFocusedRef`, we'd ship a stale
    // id into StellarGraph and trigger 'focused node not in data'.
    searchParamsRef.current = new URLSearchParams('cluster=most_active');
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: 'r-only',
          label: 'r',
          cluster: 0,
          weight: 1,
          degree: 1,
          x: 0, y: 0, z: 0,
          subject: 'r', predicate: 'supports', object: 'o',
        },
      ],
      links: [],
      clusters: ['c0'],
    } satisfies StellarGraphData);
    // Start in synthetic so cluster focus binds on fake-* first.
    window.localStorage.setItem('lucid.stellar.source', 'synthetic');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    await waitFor(() => {
      expect(['fake-1', 'fake-2']).toContain(lastRendererProps.current.focusedId);
    });
    // Toggle to real — focus must clear, and cluster auto-focus must
    // re-fire against the real graph once it loads.
    fireEvent.click(screen.getByTestId('stellar-source-real'));
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
    await waitFor(() => {
      expect(lastRendererProps.current.focusedId).toBe('r-only');
    });
    // The stale synthetic id never appears post-toggle.
    expect(['fake-1', 'fake-2']).not.toContain(lastRendererProps.current.focusedId);
  });

  it('regression: localStorage v2 migration clears stale "synthetic" once', () => {
    // PO first-visit timeline: opened /stellar when default was
    // synthetic → localStorage got 'synthetic' written by an explicit
    // toggle (or by the persistSource side-effect of an early
    // version). Later default flipped to real, but the explicit
    // 'synthetic' was honored, sending PO back into the IPCC sample.
    // v2 migration clears the stale value EXACTLY once.
    window.localStorage.removeItem('lucid.stellar.source:migrated:v2');
    window.localStorage.setItem('lucid.stellar.source', 'synthetic');
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [], links: [], clusters: [],
    } satisfies StellarGraphData);
    const { unmount } = render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    // Migration ran on mount: stale 'synthetic' cleared, marker set,
    // source is now 'real'.
    expect(window.localStorage.getItem('lucid.stellar.source:migrated:v2')).toBe('1');
    expect(window.localStorage.getItem('lucid.stellar.source')).toBeNull();
    expect(
      screen.getByTestId('stellar-source-real').getAttribute('aria-pressed'),
    ).toBe('true');
    unmount();
    // Second mount: user has since explicitly set 'synthetic' again
    // (via toggle). Migration marker is set, so the explicit value is
    // honored — we DO NOT migrate twice.
    window.localStorage.setItem('lucid.stellar.source', 'synthetic');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    expect(window.localStorage.getItem('lucid.stellar.source')).toBe('synthetic');
    expect(
      screen.getByTestId('stellar-source-synthetic').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  // -------------------------------------------------------------------------
  // fix/stellar-cluster-focus-real - entity-anchor + tier delta cases.
  // -------------------------------------------------------------------------

  describe('pickClusterFocusNode (entity-anchor paths)', () => {
    function makeData(nodes: Array<Partial<StellarNode> & { id: string }>): StellarGraphData {
      return {
        nodes: nodes.map((n) => ({
          label: n.label ?? n.id,
          cluster: n.cluster ?? 0,
          weight: n.weight ?? 1,
          x: 0, y: 0, z: 0,
          subject: n.subject ?? 's',
          predicate: n.predicate ?? 'supports',
          object: n.object ?? 'o',
          ...n,
        })) as StellarNode[],
        links: [],
        clusters: ['c'],
      };
    }

    it('Path 1: subject_uid match returns the highest-degree candidate', () => {
      const data = makeData([
        { id: 'fact-low', subject_uid: '8e68baf5', degree: 1 },
        { id: 'fact-spine', subject_uid: '8e68baf5', degree: 12 },
        { id: 'fact-mid', subject_uid: '8e68baf5', degree: 5 },
        { id: 'other', subject_uid: 'aaaaaa', degree: 99 },
      ]);
      const picked = pickClusterFocusNode(data, '8e68baf5');
      expect(picked?.id).toBe('fact-spine');
    });

    it('Path 2: object_uid match when entity appears as object', () => {
      const data = makeData([
        { id: 'fact-a', object_uid: '8e68baf5', degree: 3 },
        { id: 'fact-b', object_uid: '8e68baf5', degree: 7 },
        { id: 'other', subject_uid: 'cccc', degree: 100 },
      ]);
      const picked = pickClusterFocusNode(data, '8e68baf5');
      expect(picked?.id).toBe('fact-b');
    });

    it('Path 3: exact node.id still works (synthetic-mode path)', () => {
      const data = makeData([
        { id: 'fake-2', degree: 1 },
        { id: 'fake-1', degree: 9 },
      ]);
      const picked = pickClusterFocusNode(data, 'fake-2');
      expect(picked?.id).toBe('fake-2');
    });

    it('Path 4: truncated uid prefix matches the full id', () => {
      const data = makeData([
        { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', degree: 1 },
        { id: 'ffffffff-0000-1111-2222-333333333333', degree: 1 },
      ]);
      const picked = pickClusterFocusNode(data, 'aaaaaaaa');
      expect(picked?.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('subject_uid path beats id/label/fallback even when other node has higher degree', () => {
      const data = makeData([
        { id: 'spine', subject_uid: '8e68baf5', degree: 2 },
        { id: 'unrelated-huge', subject_uid: 'zzzz', degree: 50 },
      ]);
      const picked = pickClusterFocusNode(data, '8e68baf5');
      // The most-active fallback would have picked unrelated-huge.
      expect(picked?.id).toBe('spine');
    });

    it('miss on all paths falls back to most-active picker', () => {
      const data = makeData([
        { id: 'a', cluster: 0, degree: 1 },
        { id: 'b', cluster: 1, degree: 8 },
        { id: 'c', cluster: 1, degree: 4 },
      ]);
      const picked = pickClusterFocusNode(data, 'no-such-anything');
      expect(picked?.id).toBe('b');
    });
  });

  it('fix/stellar-cluster-focus-real - ?cluster=<entity_uid> focuses an anchored fact (real mode)', async () => {
    const ENTITY = '8e68baf5-97b1-4833-9604-a6b5dd99ec7b';
    searchParamsRef.current = new URLSearchParams(`cluster=${ENTITY}`);
    // Empty synthetic so the auto-focus does not latch on synthetic data
    // before real loads. The effect bails on empty graph, re-runs after
    // real arrives, and the subject_uid path picks the spine fact.
    function emptySyntheticBuilder(): StellarGraphData {
      return { nodes: [], links: [], clusters: [] };
    }
    const realLoader = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: 'fact-spine',
          label: 'spine',
          cluster: 0,
          weight: 1,
          degree: 12,
          x: 0, y: 0, z: 0,
          subject: '모스 탄', predicate: 'states', object: 'X',
          subject_uid: ENTITY,
        },
        {
          id: 'fact-low',
          label: 'low',
          cluster: 0,
          weight: 1,
          degree: 1,
          x: 0, y: 0, z: 0,
          subject: '모스 탄', predicate: 'states', object: 'Y',
          subject_uid: ENTITY,
        },
        {
          id: 'unrelated-hot',
          label: 'unrelated',
          cluster: 1,
          weight: 1,
          degree: 99,
          x: 0, y: 0, z: 0,
          subject: '다른 사람', predicate: 'states', object: 'Z',
          subject_uid: 'other-uid',
        },
      ],
      links: [],
      clusters: ['c0', 'c1'],
    } satisfies StellarGraphData);
    window.localStorage.setItem('lucid.stellar.source', 'real');
    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={emptySyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    // Subject_uid match - spine fact (deg 12), NOT unrelated-hot (deg 99).
    await waitFor(() => {
      expect(lastRendererProps.current.focusedId).toBe('fact-spine');
    });
  });
});
