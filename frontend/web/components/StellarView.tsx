/**
 * B-62 — StellarView: the page shell for the 3D stellar surface.
 *
 * Responsibilities:
 *   - Owns the data-source toggle (synthetic / real) persisted to localStorage.
 *   - Loads either synthetic (sync, ~2000 nodes) or real (async via adapter).
 *   - Wires hover / click handlers into a positioned tooltip + side drawer.
 *   - Renders a cold-start hint when real mode comes back with 0 nodes.
 *
 * The 3D renderer is dynamic-imported to keep SSR from touching three.js.
 * This file is render-shape only; the renderer (StellarGraph) is the
 * canvas-side recipe.
 */
'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateSyntheticGraph } from '@/lib/syntheticGraph';
import type { StellarGraphData, StellarNode } from '@/lib/syntheticGraph';
import { emptyStellarGraph, loadRealStellarGraph } from '@/lib/stellarRealAdapter';
import { predicateLabel } from '@/lib/predicateLabels';

const ACCENT = '#3fe0c6';
const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';

// Dynamic-import StellarGraph so SSR never touches three. The page itself is
// a Client Component, but Next still partially evaluates the module graph
// during build; dynamic + ssr:false short-circuits that.
const StellarGraphLazy = dynamic(
  () => import('./StellarGraph').then((m) => m.StellarGraph),
  { ssr: false },
);

export type StellarSource = 'synthetic' | 'real';
const LS_KEY = 'lucid.stellar.source';

function readPersistedSource(): StellarSource {
  if (typeof window === 'undefined') return 'synthetic';
  try {
    const v = window.localStorage.getItem(LS_KEY);
    return v === 'real' ? 'real' : 'synthetic';
  } catch {
    return 'synthetic';
  }
}

function persistSource(source: StellarSource): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, source);
  } catch {
    /* localStorage may be unavailable in some browser modes — fail-soft. */
  }
}

// ---------------------------------------------------------------------------
// Toggle pill (top-right) — synthetic / real.
// ---------------------------------------------------------------------------

interface ToggleProps {
  source: StellarSource;
  onChange: (next: StellarSource) => void;
}

function SourceToggle({ source, onChange }: ToggleProps) {
  function segment(value: StellarSource, label: string) {
    const active = source === value;
    return (
      <button
        type="button"
        data-testid={`stellar-source-${value}`}
        aria-pressed={active}
        onClick={() => onChange(value)}
        style={{
          padding: '6px 14px',
          borderRadius: 999,
          border: '1px solid transparent',
          background: active ? 'color-mix(in oklab, #3fe0c6 18%, transparent)' : 'transparent',
          color: active ? ACCENT : TEXT_BODY,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <div
      data-testid="stellar-source-toggle"
      role="group"
      aria-label="data source"
      style={{
        position: 'absolute',
        top: 16,
        right: 18,
        zIndex: 10,
        display: 'flex',
        gap: 4,
        padding: 4,
        borderRadius: 999,
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        backdropFilter: 'blur(8px)',
      }}
    >
      {segment('synthetic', 'synthetic')}
      {segment('real', 'real')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hover tooltip (positioned near the cursor).
// ---------------------------------------------------------------------------

interface HoverState {
  node: StellarNode;
  x: number;
  y: number;
}

function HoverTooltip({ state }: { state: HoverState | null }) {
  if (!state) return null;
  const { node, x, y } = state;
  return (
    <div
      data-testid="stellar-hover-tooltip"
      style={{
        position: 'fixed',
        top: y + 14,
        left: x + 14,
        zIndex: 30,
        maxWidth: 320,
        padding: '10px 12px',
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderRadius: 10,
        color: TEXT_PRIMARY,
        pointerEvents: 'none',
        fontSize: 12,
        lineHeight: 1.45,
        boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
      }}
    >
      <div style={{ color: ACCENT, fontWeight: 600 }}>{node.subject}</div>
      <div style={{ color: TEXT_DIM, fontSize: 11, marginTop: 2 }}>
        {predicateLabel(node.predicate)}
      </div>
      <div style={{ color: TEXT_BODY, marginTop: 4 }}>
        {truncate(node.object, 90)}
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Side drawer (click-to-open fact detail).
// ---------------------------------------------------------------------------

function FactDrawer({
  node,
  onClose,
}: {
  node: StellarNode | null;
  onClose: () => void;
}) {
  if (!node) return null;
  return (
    <aside
      data-testid="stellar-fact-drawer"
      role="dialog"
      aria-label="fact detail"
      style={{
        position: 'absolute',
        top: 16,
        right: 18,
        zIndex: 20,
        width: 380,
        maxHeight: 'calc(100% - 32px)',
        overflowY: 'auto',
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderRadius: 14,
        padding: 18,
        marginTop: 56, // sit just below the source-toggle pill
        color: TEXT_PRIMARY,
        boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(10px)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ color: ACCENT, fontSize: 11, letterSpacing: '0.08em', fontWeight: 600 }}>
          STELLAR · FACT
        </span>
        <button
          type="button"
          data-testid="stellar-drawer-close"
          onClick={onClose}
          aria-label="close"
          style={{
            background: 'transparent',
            border: 'none',
            color: TEXT_DIM,
            fontSize: 18,
            cursor: 'pointer',
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      </header>
      <div style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY, lineHeight: 1.5 }}>
        {node.subject}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: TEXT_DIM }}>
        {predicateLabel(node.predicate)}
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: TEXT_BODY, lineHeight: 1.6 }}>
        {node.object}
      </div>
      <div style={{ marginTop: 16, fontSize: 11, color: TEXT_DIM }}>
        cluster #{node.cluster} · weight {node.weight}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: TEXT_DIM }}>
        node id: <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{node.id}</span>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Empty state — cold-start hint when real mode returns nothing.
// ---------------------------------------------------------------------------

function ColdStartHint() {
  return (
    <div
      data-testid="stellar-empty-hint"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: TEXT_BODY,
        pointerEvents: 'none',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 14, color: ACCENT, letterSpacing: '0.08em' }}>STELLAR · EMPTY</div>
      <div style={{ fontSize: 13 }}>그래프 비어 있음 — 캡처된 사실이 아직 없습니다.</div>
      <div style={{ fontSize: 11, color: TEXT_DIM }}>위의 synthetic 모드에서 데모 우주를 볼 수 있어요.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status pill (bottom-left) — small diagnostic for the spike.
// ---------------------------------------------------------------------------

function StatusPill({ source, nodes, links }: { source: StellarSource; nodes: number; links: number }) {
  return (
    <div
      data-testid="stellar-status-pill"
      style={{
        position: 'absolute',
        bottom: 18,
        left: 18,
        zIndex: 10,
        padding: '8px 12px',
        borderRadius: 999,
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        color: TEXT_BODY,
        fontSize: 11,
        letterSpacing: '0.04em',
        fontFamily: 'JetBrains Mono, monospace',
        display: 'flex',
        gap: 14,
      }}
    >
      <span>{source}</span>
      <span style={{ color: TEXT_DIM }}>·</span>
      <span>nodes {nodes.toLocaleString()}</span>
      <span style={{ color: TEXT_DIM }}>·</span>
      <span>edges {links.toLocaleString()}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component.
// ---------------------------------------------------------------------------

export interface StellarViewProps {
  /** Test-mode override: swap the renderer for a mock component. The
   *  vitest jsdom environment can't run three.js. */
  renderer?: (props: {
    data: StellarGraphData;
    mode: StellarSource;
    onNodeHover?: (n: StellarNode | null) => void;
    onNodeClick?: (n: StellarNode) => void;
  }) => React.ReactElement;
  /** Test-mode override for the real-data adapter. */
  realLoader?: () => Promise<StellarGraphData>;
  /** Test-mode override for the synthetic generator. */
  syntheticBuilder?: () => StellarGraphData;
}

export function StellarView(props: StellarViewProps = {}) {
  const [source, setSource] = useState<StellarSource>('synthetic');
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [selected, setSelected] = useState<StellarNode | null>(null);
  const [realData, setRealData] = useState<StellarGraphData | null>(null);
  const [realLoading, setRealLoading] = useState(false);
  const realLoadedRef = useRef(false);

  // Re-hydrate the persisted toggle on mount (no SSR mismatch — useEffect runs client-side only).
  useEffect(() => {
    const persisted = readPersistedSource();
    setSource(persisted);
  }, []);

  // Cursor position for tooltip placement.
  const cursorRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    function onMove(e: MouseEvent) {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    }
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // Synthetic data — memoized, built once per mount. We capture the builder
  // override (test seam) in a ref so the useMemo runs exactly once without
  // a missing-dep warning.
  const syntheticBuilderRef = useRef<() => StellarGraphData>(
    props.syntheticBuilder ?? generateSyntheticGraph,
  );
  const syntheticData = useMemo<StellarGraphData>(
    () => syntheticBuilderRef.current(),
    [],
  );

  // Real data — lazy-load when the user flips to 'real'.
  useEffect(() => {
    if (source !== 'real') return;
    if (realLoadedRef.current) return;
    realLoadedRef.current = true;
    setRealLoading(true);
    const loader = props.realLoader ?? loadRealStellarGraph;
    loader()
      .then((d) => setRealData(d))
      .catch(() => setRealData(emptyStellarGraph()))
      .finally(() => setRealLoading(false));
  }, [source, props.realLoader]);

  const activeData = source === 'synthetic' ? syntheticData : (realData ?? emptyStellarGraph());

  const handleToggle = useCallback((next: StellarSource) => {
    setSource(next);
    persistSource(next);
    setHovered(null);
    setSelected(null);
  }, []);

  const handleHover = useCallback((node: StellarNode | null) => {
    if (!node) {
      setHovered(null);
      return;
    }
    setHovered({ node, x: cursorRef.current.x, y: cursorRef.current.y });
  }, []);

  const handleClick = useCallback((node: StellarNode) => {
    setSelected(node);
  }, []);

  const Renderer = props.renderer ?? StellarGraphLazy;

  const realIsEmpty = source === 'real' && !realLoading && activeData.nodes.length === 0;

  return (
    <div
      data-testid="stellar-view"
      style={{
        position: 'relative',
        width: '100%',
        height: 'calc(100vh - 64px)', // subtract AppShell header
        background: '#000',
        color: TEXT_PRIMARY,
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <Renderer
          data={activeData}
          mode={source}
          onNodeHover={handleHover}
          onNodeClick={handleClick}
        />
      </div>

      <SourceToggle source={source} onChange={handleToggle} />

      {realIsEmpty ? <ColdStartHint /> : null}

      <StatusPill source={source} nodes={activeData.nodes.length} links={activeData.links.length} />

      <HoverTooltip state={hovered} />
      <FactDrawer node={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default StellarView;
