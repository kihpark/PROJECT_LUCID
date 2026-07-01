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
  onLinkClick?: (endpoints: { a: StellarNode; b: StellarNode }) => void;
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
      <button
        type="button"
        data-testid="mock-fire-link-click"
        onClick={() => {
          const a = props.data.nodes[0];
          const b = props.data.nodes[1];
          if (a && b) props.onLinkClick?.({ a, b });
        }}
      >
        link
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
    expect(screen.queryByTestId('stellar-hover-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();

    // Hover fake-1 (action by default) → tooltip up.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = await screen.findByTestId('stellar-hover-card');
    expect(tip).toBeInTheDocument();
    expect(tip.getAttribute('data-fact-type')).toBe('action');

    // Click → side panel opens, tooltip still allowed to stay (coexist).
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    await waitFor(() => expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument());
    expect(screen.getByTestId('stellar-hover-card')).toBeInTheDocument();
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
    const tip = screen.getByTestId('stellar-hover-card');
    expect(tip.getAttribute('data-fact-type')).toBe('action');
    expect(screen.getByTestId('stellar-hover-card-subject').textContent).toBe('한국은행');
    // predicate 'is_examining' maps to '검토 중인 것은' via predicateLabel.
    expect(screen.getByTestId('stellar-hover-card-predicate').textContent).toContain('→');
    expect(screen.getByTestId('stellar-hover-card-predicate').textContent).toContain('검토 중인 것은');
    expect(screen.getByTestId('stellar-hover-card-object').textContent).toBe('환율 변동성');
    // Action with no as_of → no foot.
    expect(screen.queryByTestId('stellar-hover-card-foot')).not.toBeInTheDocument();
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
    // ★ N1 (2026-06-29) — CLAIM toggle defaults ON now, so claim nodes
    // are visible by default; no extra click required.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const tip = screen.getByTestId('stellar-hover-card');
    expect(tip.getAttribute('data-fact-type')).toBe('claim');
    // Speaker on the head, bracketed speech_act on the mid, content on the body.
    expect(screen.getByTestId('stellar-hover-card-speaker').textContent).toBe('한국은행');
    // '발표했다' is a natural-language verb (not assertion/judgment/opinion)
    // so it falls through verbatim — no modality classification, no brackets.
    expect(screen.getByTestId('stellar-hover-card-speech-act').textContent).toBe('발표했다');
    expect(screen.getByTestId('stellar-hover-card-content').textContent).toContain(
      '환율 변동성 상승 가능성',
    );
    expect(screen.queryByTestId('stellar-hover-card-foot')).not.toBeInTheDocument();
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
    const tip = screen.getByTestId('stellar-hover-card');
    expect(tip.getAttribute('data-fact-type')).toBe('measurement');
    expect(screen.getByTestId('stellar-hover-card-entity').textContent).toBe('Meta');
    // New card collapses metric/value/unit onto a single line.
    const mline = screen.getByTestId('stellar-hover-card-metric').textContent ?? '';
    expect(mline).toContain('MAU');
    expect(mline).toContain('800000000');
    expect(mline).toContain('명');
    // Measurement carries the as_of footer.
    expect(screen.getByTestId('stellar-hover-card-foot').textContent).toContain('2026-03');
  });

  it('hover tooltip + side panel can coexist (hover = peek, click = read)', async () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    await waitFor(() => expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument());
    // Hover ALSO emits a tooltip while the side panel is open.
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    expect(screen.getByTestId('stellar-hover-card')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
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

  it.skip('focus opens the panel with a relations list (clickable for chain-navigate)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
    const rows = screen.queryAllByTestId('stellar-focus-relation-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // B-62-focus-select-actions — relation row click now selects without
  // re-centring; the user must hit 중심으로 to push history.
  it.skip('back button pops focus history; disabled at the root', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
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

  it.skip('relation row click sets selected (NO focus change, NO history push)', () => {
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

  it.skip('action footer appears only when selected differs from focused', () => {
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

  it.skip('펼치기 keeps focus + selected but enlarges the neighbour set', () => {
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
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
  });

  // B-62-clear-focus-home-lookat — viewResetTick bumps on every
  // explicit "back to overview" event but stays stable while the
  // user is actively focusing nodes.
  it.skip('viewResetTick stays at 0 through a focus + relation-row click', () => {
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
    fireEvent.click(screen.getByTestId('stellar-entity-card-close'));
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

  // fix/stellar-remove-old-edge-panel - EdgeLegend was removed from
  // the StellarView JSX; this test is obsolete and kept as a skipped
  // marker so the history reads cleanly.
  it.skip('edge legend shows the 4 relation types in synthetic mode (legacy - EdgeLegend removed)', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    expect(screen.getByTestId('stellar-edge-legend')).toBeInTheDocument();
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
      expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
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
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
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
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
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

  it.skip('#9 — hover SPO card carries a theme color matched to predicate', () => {
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
    const tip = screen.getByTestId('stellar-hover-card');
    expect(tip.getAttribute('data-theme-color')).toBe('#f06a78');
  });

  it.skip('#9 — concord predicate gets the teal accent', () => {
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
    const tip = screen.getByTestId('stellar-hover-card');
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

  // ★ REQ-013 (PO 2026-07-02) — 옛 우상단 stellar-claim-toggle 버튼 폐기 +
  //   좌하단 StellarLeftPanel (stellar-filter-entity-*) 폐기. 두 기능은
  //   StellarLegend row 클릭으로 통합. 이 describe 블록의 회귀 잠금은
  //   대응 UI 가 사라졌으므로 skip. legend row 토글 검증은 새 스펙에서 담당.
  describe.skip('M3-2c layer toggle + filters', () => {
    function mixedBuilder(): StellarGraphData {
      return {
        nodes: [
          { id: 'a-1', label: 'A', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'A', predicate: 'supports', object: 'X',
            fact_type: 'action', entity_type: 'person' },
          { id: 'c-1', label: 'C', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'A', predicate: 'states', object: 'Y',
            fact_type: 'claim', entity_type: 'person',
            speaker_label: 'A', speech_act: '말함', content_claim: 'Y' },
          { id: 'm-1', label: 'M', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'B', predicate: 'has_metric', object: '5 명',
            fact_type: 'measurement', entity_type: 'concept',
            metric: 'MAU', measurement_value: 5, measurement_unit: '명',
            as_of: '2026-03-01' },
          { id: 'loc-1', label: 'L', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: '서울', predicate: 'supports', object: 'V',
            fact_type: 'action', entity_type: 'location' },
        ],
        links: [
          { source: 'a-1', target: 'm-1', type: 'supports', link_status: 'verified' },
          { source: 'c-1', target: 'a-1', type: 'supports', link_status: 'claimed' },
        ],
        clusters: ['mixed'],
      };
    }

    it('★ N1 default view: claim nodes are SHOWN (default ON, 2026-06-29)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      const ids = (lastRendererProps.current.data.nodes as StellarNode[]).map((n) => n.id);
      expect(ids).toContain('c-1');
      expect(ids).toContain('a-1');
      expect(ids).toContain('m-1');
    });

    it('★ N1 CLAIM toggle OFF: claim nodes and claimed links HIDDEN', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      const toggle = screen.getByTestId('stellar-claim-toggle');
      // ★ N1 (2026-06-29) — default ON. aria-pressed starts 'true'.
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      const ids = (lastRendererProps.current.data.nodes as StellarNode[]).map((n) => n.id);
      expect(ids).not.toContain('c-1');
      // Claimed link is gone too.
      const links = lastRendererProps.current.data.links as Array<{ link_status?: string }>;
      expect(links.some((l) => l.link_status === 'claimed')).toBe(false);
    });

    it('CLAIM toggle label flips between 숨김 (default ON) and 보기 (OFF)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      const toggle = screen.getByTestId('stellar-claim-toggle');
      // ★ N1 (2026-06-29) — default ON → label '숨김'.
      expect(toggle.textContent).toContain('숨김');
      fireEvent.click(toggle);
      expect(toggle.textContent).toContain('보기');
    });

    it('entity-bucket filter: unchecking WHO hides person/organization/group nodes', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      // a-1 (person) survives by default.
      let ids = (lastRendererProps.current.data.nodes as StellarNode[]).map((n) => n.id);
      expect(ids).toContain('a-1');
      // Uncheck WHO.
      const who = screen.getByTestId('stellar-filter-entity-who') as HTMLInputElement;
      fireEvent.click(who);
      ids = (lastRendererProps.current.data.nodes as StellarNode[]).map((n) => n.id);
      expect(ids).not.toContain('a-1');  // person → who → hidden
      expect(ids).toContain('m-1');  // concept → what → still shown
      expect(ids).toContain('loc-1');  // location → where → still shown
    });

    // fix/stellar-leftpanel-simplify (2026-06-28 PO) - left-panel reduced
    // to ENTITY only. fact_type UI filter removed; the data field is
    // preserved on nodes (and still drives the CLAIM toggle path) but no
    // longer carries its own left-panel control.
    it('fact_type left-panel control is REMOVED (PO 2026-06-28 simplify)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      expect(screen.queryByTestId('stellar-filter-fact-type-action')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stellar-filter-fact-type-claim')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stellar-filter-fact-type-measurement')).not.toBeInTheDocument();
    });

    // fix/stellar-leftpanel-simplify - as_of UI filter removed (data
    // field preserved on nodes for tooltip / cards).
    it('as_of left-panel control is REMOVED (PO 2026-06-28 simplify)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      expect(screen.queryByTestId('stellar-filter-as-of-from')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stellar-filter-as-of-to')).not.toBeInTheDocument();
    });

    // fix/stellar-leftpanel-simplify - link_status UI filter removed.
    // The data field (link.link_status) STILL gates the CLAIM toggle's
    // 'claimed' link-hide path, but it no longer has its own select.
    it('★ link_status left-panel control is REMOVED; data field still preserved on links (2026-06-28 PO simplify)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      // The left-panel control is gone.
      expect(screen.queryByTestId('stellar-filter-link-status')).not.toBeInTheDocument();
      // BUT link_status is still preserved on the link DATA (used by
      // the CLAIM toggle path). ★ N1 (2026-06-29) — CLAIM toggle is now
      // ON by default → claimed links already surface, no click needed.
      const links = lastRendererProps.current.data.links as Array<{ link_status?: string }>;
      expect(links.some((l) => l.link_status === 'verified')).toBe(true);
      expect(links.some((l) => l.link_status === 'claimed')).toBe(true);
      // ★ No visual style key derived from link_status leaks to the
      // renderer (M3-2b/2c/2d invariant preserved).
      expect(lastRendererProps.current).not.toHaveProperty('linkStatusOpacity');
      expect(lastRendererProps.current).not.toHaveProperty('linkStatusDashed');
    });

    it('★ regression: CLAIM toggle off filters OUT, never sets opacity (2026-06-28 PO correction)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={mixedBuilder} />);
      // ★ N1 (2026-06-29) — toggle defaults ON. Flip it OFF first to
      //   exercise the hide path, then assert the claim is filtered out.
      fireEvent.click(screen.getByTestId('stellar-claim-toggle'));
      const ids = (lastRendererProps.current.data.nodes as StellarNode[]).map((n) => n.id);
      // The claim node MUST be absent from the data — not present-with-opacity.
      expect(ids).not.toContain('c-1');
      // And no opacity-related prop leaked to the renderer.
      expect(lastRendererProps.current).not.toHaveProperty('claimOpacity');
      expect(lastRendererProps.current).not.toHaveProperty('hideClaimsViaOpacity');
    });
  });
  // -------------------------------------------------------------------------
  // M3-2d interactions wiring (PO 의뢰서 verbatim).
  // -------------------------------------------------------------------------

  describe('M3-2d wiring (PO 의뢰서)', () => {
    it('hover → StellarHoverCard (★ 단일 카드)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
      fireEvent.click(screen.getByTestId('mock-fire-hover'));
      const cards = document.querySelectorAll('[data-testid="stellar-hover-card"]');
      expect(cards.length).toBe(1);
      // No old hover-tooltip overlay.
      expect(screen.queryByTestId('stellar-hover-tooltip')).not.toBeInTheDocument();
    });

    it('노드 클릭 → StellarEntityCard 가 우패널에 마운트', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
      expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('mock-fire-click'));
      expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
    });

    it('엣지 클릭 → StellarEdgeFactsList 가 우패널에 마운트', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
      expect(screen.queryByTestId('stellar-edge-facts-list')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('mock-fire-link-click'));
      expect(screen.getByTestId('stellar-edge-facts-list')).toBeInTheDocument();
    });

    it('엣지 클릭은 entity 카드를 덮어쓴다 (둘 중 하나만 보임)', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
      fireEvent.click(screen.getByTestId('mock-fire-click'));
      expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('mock-fire-link-click'));
      // EdgeFactsList wins; EntityCard yields.
      expect(screen.getByTestId('stellar-edge-facts-list')).toBeInTheDocument();
      expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
    });

    it('노드 클릭은 엣지 패널을 닫는다', () => {
      render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
      fireEvent.click(screen.getByTestId('mock-fire-link-click'));
      expect(screen.getByTestId('stellar-edge-facts-list')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('mock-fire-click'));
      expect(screen.queryByTestId('stellar-edge-facts-list')).not.toBeInTheDocument();
      expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
    });
  });

});

// ---------------------------------------------------------------------------
// M3-2e regression guard - interactions (PO request verbatim).
//
// Guards specified:
//   - cluster focus matches entity_uid (after M3-2d EntityCard)
//   - single SPO card (no duplicate overlay)
//   - M3-2b visual + M3-2c filters + M3-2d cards all work together
//   - dashed/dim/grey regression guard (PO 2026-06-28 correction)
//   - localStorage v2 migration preserved (no synthetic default leak)
// ---------------------------------------------------------------------------

describe('M3-2e regression guard - interactions', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('lucid.stellar.source:migrated:v2', '1');
    window.localStorage.setItem('lucid.stellar.source', 'synthetic');
    lastRendererProps.current = null;
    searchParamsRef.current = new URLSearchParams();
  });

  it('cluster focus matches entity_uid (after M3-2d EntityCard)', async () => {
    const ENTITY = 'reg-uid-m32e-001';
    searchParamsRef.current = new URLSearchParams('cluster=' + ENTITY);
    function builder(): StellarGraphData {
      return {
        nodes: [
          { id: 'fact-spine', label: 'spine', cluster: 0, weight: 1, degree: 12,
            x: 0, y: 0, z: 0,
            subject: 'X', predicate: 'states', object: 'Y',
            subject_uid: ENTITY },
          { id: 'fact-low', label: 'low', cluster: 0, weight: 1, degree: 1,
            x: 0, y: 0, z: 0,
            subject: 'X', predicate: 'states', object: 'Z',
            subject_uid: ENTITY },
          { id: 'unrelated', label: 'unrelated', cluster: 1, weight: 1, degree: 99,
            x: 0, y: 0, z: 0,
            subject: 'other', predicate: 'states', object: 'Q',
            subject_uid: 'different-uid' },
        ],
        links: [],
        clusters: ['c0', 'c1'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={builder} />);
    await waitFor(() => {
      expect(lastRendererProps.current.focusedId).toBe('fact-spine');
    });
    await waitFor(() => {
      expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
    });
  });

  it('single SPO card (no duplicate overlay): hover -> StellarHoverCard 1 element', () => {
    render(<StellarView renderer={MockRenderer} syntheticBuilder={fakeSyntheticBuilder} />);
    fireEvent.click(screen.getByTestId('mock-fire-hover'));
    const hoverCards = document.querySelectorAll('[data-testid="stellar-hover-card"]');
    expect(hoverCards.length).toBe(1);
    expect(screen.queryByTestId('stellar-hover-tooltip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-node-label-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-focus-panel')).not.toBeInTheDocument();
  });

  // ★ REQ-013 (PO 2026-07-02) — stellar-claim-toggle + stellar-filter-entity-*
  //   폐기. StellarLegend row 로 통합. skip.
  it.skip('M3-2b visual vocab + M3-2c toggle + M3-2d card all work together', () => {
    function builder(): StellarGraphData {
      return {
        nodes: [
          { id: 'a-1', label: 'A', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'A', predicate: 'supports', object: 'X',
            fact_type: 'action', entity_type: 'person' },
          { id: 'a-2', label: 'A2', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'B', predicate: 'supports', object: 'Y',
            fact_type: 'action', entity_type: 'person' },
        ],
        links: [
          { source: 'a-1', target: 'a-2', type: 'supports', link_status: 'verified' },
        ],
        clusters: ['mixed'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={builder} />);
    expect(screen.getByTestId('stellar-filter-entity-who')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-filter-entity-what')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-filter-entity-where')).toBeInTheDocument();
    // fix/stellar-leftpanel-simplify (2026-06-28 PO) - fact_type +
    // link_status left-panel controls removed; only ENTITY survives.
    expect(screen.queryByTestId('stellar-filter-fact-type-action')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-filter-link-status')).not.toBeInTheDocument();
    const claimToggle = screen.getByTestId('stellar-claim-toggle');
    // ★ N1 (2026-06-29) — default flipped to ON.
    expect(claimToggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-fire-link-click'));
    expect(screen.getByTestId('stellar-edge-facts-list')).toBeInTheDocument();
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
  });

  // ★ REQ-013 (PO 2026-07-02) — stellar-claim-toggle 폐기. skip.
  it.skip('dashed/dim/grey regression guard (PO 2026-06-28 correction)', () => {
    function builder(): StellarGraphData {
      return {
        nodes: [
          { id: 'n1', label: 'N1', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'X', predicate: 'supports', object: 'Y',
            fact_type: 'action' },
          { id: 'n2', label: 'N2', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
            subject: 'X', predicate: 'states', object: 'Z',
            fact_type: 'claim',
            speaker_label: 'X', speech_act: 'assertion', content_claim: 'Z' },
        ],
        links: [
          { source: 'n1', target: 'n2', type: 'supports', link_status: 'verified' },
          { source: 'n2', target: 'n1', type: 'elaborates', link_status: 'claimed' },
        ],
        clusters: ['mixed'],
      };
    }
    render(<StellarView renderer={MockRenderer} syntheticBuilder={builder} />);
    // ★ N1 (2026-06-29) — toggle defaults ON now. Flipping once exercises
    //   the OFF→ON→OFF cycle so the invariant holds across both states.
    fireEvent.click(screen.getByTestId('stellar-claim-toggle'));
    const props = lastRendererProps.current as any;
    expect(props).not.toHaveProperty('linkStatusOpacity');
    expect(props).not.toHaveProperty('linkStatusDashed');
    expect(props).not.toHaveProperty('linkStatusGrey');
    expect(props).not.toHaveProperty('linkStatusColor');
    expect(props).not.toHaveProperty('claimOpacity');
    expect(props).not.toHaveProperty('hideClaimsViaOpacity');
    const links = (props.data.links as Array<Record<string, unknown>>);
    for (const l of links) {
      expect(l).not.toHaveProperty('dashed');
      expect(l).not.toHaveProperty('opacity');
      expect(l).not.toHaveProperty('greyOut');
      if ('link_status' in l) {
        expect(['verified', 'claimed', null, undefined]).toContain(l.link_status);
      }
    }
  });

  it('localStorage v2 migration preserved (no synthetic default leak)', () => {
    window.localStorage.removeItem('lucid.stellar.source');
    window.localStorage.removeItem('lucid.stellar.source:migrated:v2');
    window.localStorage.setItem('lucid.stellar.source', 'synthetic');
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
    expect(window.localStorage.getItem('lucid.stellar.source:migrated:v2')).toBe('1');
    expect(window.localStorage.getItem('lucid.stellar.source')).toBeNull();
    expect(
      screen.getByTestId('stellar-source-real').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('mode-switch resets focusedId (b9f7056 preserved)', async () => {
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
    fireEvent.click(screen.getByTestId('mock-fire-click'));
    expect(lastRendererProps.current.focusedId).toBe('fake-1');
    expect(screen.getByTestId('stellar-entity-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stellar-source-real'));
    await waitFor(() => expect(realLoader).toHaveBeenCalled());
    expect(lastRendererProps.current.focusedId).toBeNull();
    expect(screen.queryByTestId('stellar-entity-card')).not.toBeInTheDocument();
  });

  // ★ REQ-012 UI 완성도 fix (PO 2026-07-01) — 저장 후 STELLAR 즉시 반영.
  //   handleEntityChanged 가 (1) realLoader 를 refetch (★ 새 색/형태/topology)
  //   하고 (2) focused entity 상태를 fresh 그래프 노드로 rebind → EntityCard
  //   에 새 entity_type 이 즉시 반영 (stale 표시 회귀 방지).
  it('★ REQ-012 UI 완성도: EntityTypeDropdown 저장 → refetch + focused rebind', async () => {
    const before: StellarGraphData = {
      nodes: [
        {
          id: 'ent-광주', label: '광주', cluster: 0, weight: 5,
          x: 0, y: 0, z: 0,
          subject: '광주', predicate: '', object: '',
          kind: 'entity',
          entity_type: 'organization',
        },
      ],
      links: [],
      clusters: ['space'],
    };
    const after: StellarGraphData = {
      nodes: [
        {
          id: 'ent-광주', label: '광주', cluster: 0, weight: 5,
          x: 0, y: 0, z: 0,
          subject: '광주', predicate: '', object: '',
          kind: 'entity',
          entity_type: 'location',
        },
      ],
      links: [],
      clusters: ['space'],
    };
    let call = 0;
    const realLoader = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1 ? before : after;
    });
    // spaceId 필요 (dropdown 이 활성화되도록).
    window.localStorage.setItem('lucid_space_id', 'space-abc');
    window.localStorage.setItem('lucid.stellar.source', 'real');

    // API mock: changeEntityType.
    const api = await import('@/lib/api');
    const changeSpy = vi.spyOn(api, 'changeEntityType').mockResolvedValue({
      entity_uid: 'ent-광주',
      primary_label: '광주',
      previous_entity_type: 'organization',
      entity_type: 'location',
      relabel_history_size: 1,
      updated_at: '2026-07-01T00:00:00Z',
    });

    render(
      <StellarView
        renderer={MockRenderer}
        syntheticBuilder={fakeSyntheticBuilder}
        realLoader={realLoader}
      />,
    );
    await waitFor(() => expect(realLoader).toHaveBeenCalledTimes(1));

    // 1) 노드 focus → entity card 진입.
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-fire-click'));
    });
    const typeEl = await screen.findByTestId('stellar-entity-card-type');
    expect(typeEl.getAttribute('data-entity-type')).toBe('organization');

    // 2) ★ REQ-013 (PO 2026-07-02) — native <select> 폐기 → custom dropdown.
    //   trigger 열고 option 클릭.
    await act(async () => {
      fireEvent.click(screen.getByTestId('entity-type-select'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('entity-type-option-location'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('entity-type-save'));
    });

    // 3) API 호출 + refetch 발생.
    expect(changeSpy).toHaveBeenCalledWith('space-abc', 'ent-광주', 'location');
    await waitFor(() => expect(realLoader).toHaveBeenCalledTimes(2));

    // 4) focused rebind → EntityCard 가 fresh entity_type 노출.
    await waitFor(() => {
      const t = screen.getByTestId('stellar-entity-card-type');
      expect(t.getAttribute('data-entity-type')).toBe('location');
    });

    changeSpy.mockRestore();
  });

  it('pickClusterFocusNode 6-path resolver preserved (after M3-2d)', () => {
    expect(typeof pickClusterFocusNode).toBe('function');
    const data: StellarGraphData = {
      nodes: [
        { id: 'spine', label: 'spine', cluster: 0, weight: 1, x: 0, y: 0, z: 0,
          subject: 'X', predicate: 'states', object: 'Y',
          subject_uid: 'entity-A', degree: 12 },
      ],
      links: [],
      clusters: ['c'],
    };
    expect(pickClusterFocusNode(data, 'entity-A')?.id).toBe('spine');
    expect(pickClusterFocusNode(data, 'spine')?.id).toBe('spine');
    expect(pickClusterFocusNode(data, 'most_active')?.id).toBe('spine');
  });
});
