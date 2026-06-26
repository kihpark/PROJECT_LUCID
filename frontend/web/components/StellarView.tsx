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
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  generateSyntheticGraph,
  EDGE_COLORS,
  type EdgeType,
} from '@/lib/syntheticGraph';
import type { StellarGraphData, StellarNode } from '@/lib/syntheticGraph';
import { emptyStellarGraph, loadRealStellarGraph } from '@/lib/stellarRealAdapter';
import { predicateLabel } from '@/lib/predicateLabels';

// ---------------------------------------------------------------------------
// fix/stellar-cleanup #9 — predicate / fact-type theme color.
//
// Hover SPO card segments (subject / predicate / object) are tinted by the
// relationship semantics. Validation-relevant predicates win a strong
// accent so the user can read tone at a glance:
//
//   • is_consistent_with / supports / confirms      → teal (concord)
//   • contradicts / refutes / disputes              → soft red (discord)
//   • elaborates / is_examining / states            → cyan (informational)
//   • causes / triggers / results_in                → amber (causal)
//   • everything else                               → muted grey (neutral)
//
// Pure function so the StellarView tests can assert the mapping without
// rendering. Lower-case substring match keeps it resilient to predicate
// variants like `is_consistent_with_v2` etc.
// ---------------------------------------------------------------------------

export function predicateThemeColor(predicate: string | null | undefined): string {
  const p = (predicate ?? '').toLowerCase();
  if (!p) return '#9db0b5';
  // Discord first — `contradicts` is the most load-bearing alarm signal.
  if (p.includes('contradict') || p.includes('refute') || p.includes('dispute') || p.includes('opposes')) {
    return '#f06a78';
  }
  // Concord — supports / confirms / is_consistent_with cluster.
  if (p.includes('consistent') || p.includes('support') || p.includes('confirm') || p.includes('corroborate')) {
    return '#4FD1C5';
  }
  // Causal — explicit cause / effect language.
  if (p.includes('cause') || p.includes('trigger') || p.includes('result') || p.includes('lead_to')) {
    return '#f5b95c';
  }
  // Informational / elaborative — explanatory predicates.
  if (p.includes('elaborate') || p.includes('examin') || p.includes('state') || p.includes('explain') || p.includes('describe')) {
    return '#39d3ec';
  }
  return '#9db0b5';
}

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

// B-62-v1 — relation row shape used by the focus panel.
interface FocusRelation {
  type: EdgeType;
  direction: 'out' | 'in';
  other: StellarNode;
}

function readPersistedSource(): StellarSource {
  // fix/stellar-default-real (2026-06-26): default = 'real' on first
  // visit. PO 의 살펴보기 흐름이 synthetic 모드로 떨어져 IPCC sample
  // 노드 만 보였음. localStorage 에 'synthetic' 명시된 경우만 synthetic
  // (사용자가 toggle 후 의도 보존), 그 외 모두 real.
  if (typeof window === 'undefined') return 'real';
  try {
    const v = window.localStorage.getItem(LS_KEY);
    return v === 'synthetic' ? 'synthetic' : 'real';
  } catch {
    return 'real';
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
// feat/hearth-oracle-merge + fix/stellar-cluster-focus-real — cluster-focus
// query param resolver.
//
// HomePage 살펴보기 link routes to /stellar?cluster=<entity_uid> or
// /stellar?cluster=most_active. PO repro (2026-06-24) on real mode:
//
//   URL: /stellar?cluster=8e68baf5-...  (entity_uid for 모스 탄, deg 12)
//   Outcome: 엉뚱한 노드 선택 — the highest-degree fact in the WHOLE
//   graph was picked instead of a fact tied to this entity.
//
// Root cause: the real adapter creates one node per FACT, so
// node.id === fact_uid. The cluster param carries the SUBJECT entity_uid
// — no node has that uid as its id, ever. The previous resolver matched by
// id then by substring on the human-readable label; both miss entity_uid
// in real mode (entity_uid is a UUID, never a substring of any rendered
// label). Fall-through landed on the most-active fallback — globally
// hottest cluster, NOT the requested entity. PO called this 엉뚱.
//
// Fix: a layered resolver that tries the entity-anchor paths FIRST, then
// id, then human-readable label, then most-active fallback. For each
// path we pick the HIGHEST-DEGREE matching node as the anchor — so the
// camera lands on the spine fact of the entity instead of a stray leaf.
// Verbose console.debug at every branch so PO can trace flow in DevTools
// without source modifications.
//
// Resolution order (first match wins; match = >=1 candidate node):
//   1. clusterParam === node.subject_uid   (entity-anchor, subject side)
//   2. clusterParam === node.object_uid    (entity-anchor, object side)
//   3. clusterParam === node.id            (exact fact_uid)
//   4. node.id endsWith / contains clusterParam (truncated uid forms)
//   5. clusterParam (lower) matches subject/object/label substring
//   6. most-active fallback (highest summed-degree cluster)
// ---------------------------------------------------------------------------

/** Internal helper — pick the highest-degree node out of a candidate list.
 *  When ties occur (same degree), the first wins (stable, depends on the
 *  graph data ordering). Returns null on empty list. */
function pickHighestDegree(candidates: StellarNode[]): StellarNode | null {
  if (candidates.length === 0) return null;
  let best: StellarNode = candidates[0]!;
  let bestDeg = best.degree ?? 0;
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const d = c.degree ?? 0;
    if (d > bestDeg) {
      best = c;
      bestDeg = d;
    }
  }
  return best;
}

export function pickClusterFocusNode(
  data: StellarGraphData,
  clusterParam: string,
): StellarNode | null {
  if (data.nodes.length === 0) {
    console.warn('[stellar] pickClusterFocusNode: empty graph', { clusterParam });
    return null;
  }

  if (clusterParam && clusterParam !== 'most_active') {
    // Sample of node ids for DevTools breadcrumb — helps PO eyeball the
    // node.id shape vs the clusterParam shape (UUID? prefix? truncated?).
    const idSample = data.nodes.slice(0, 5).map((n) => n.id);
    console.debug('[stellar] pickClusterFocusNode: resolving', {
      clusterParam,
      totalNodes: data.nodes.length,
      nodeIdSample: idSample,
    });

    // Path 1 — entity-anchor on SUBJECT side. The real adapter populates
    // subject_uid from RecallFact.subject_uid. Matches every fact whose
    // subject is the requested entity then picks the highest-degree (spine).
    const bySubjectUid = data.nodes.filter((n) => n.subject_uid === clusterParam);
    if (bySubjectUid.length > 0) {
      const pick = pickHighestDegree(bySubjectUid)!;
      console.debug('[stellar] pickClusterFocusNode: matched by subject_uid', {
        clusterParam,
        candidates: bySubjectUid.length,
        pickedId: pick.id,
        pickedSubject: pick.subject,
        pickedDegree: pick.degree ?? null,
      });
      return pick;
    }

    // Path 2 — entity-anchor on OBJECT side. Real adapter populates
    // object_uid only when the fact object_value is a UUID4 entity ref
    // (literals leave it null). Same picker: highest-degree wins.
    const byObjectUid = data.nodes.filter((n) => n.object_uid === clusterParam);
    if (byObjectUid.length > 0) {
      const pick = pickHighestDegree(byObjectUid)!;
      console.debug('[stellar] pickClusterFocusNode: matched by object_uid', {
        clusterParam,
        candidates: byObjectUid.length,
        pickedId: pick.id,
        pickedDegree: pick.degree ?? null,
      });
      return pick;
    }

    // Path 3 — exact node.id match. Used by the synthetic mode tests
    // (?cluster=fake-2) and by any caller that happens to know a fact_uid.
    const byId = data.nodes.find((n) => n.id === clusterParam);
    if (byId) {
      console.debug('[stellar] pickClusterFocusNode: matched by id', {
        clusterParam,
        nodeId: byId.id,
      });
      return byId;
    }

    // Path 4 — id endsWith / contains. Defensive against truncated uid
    // forms (some surfaces ship a short id like 8e68baf5 instead of
    // the full UUID; we treat that as a soft prefix match).
    const byIdPrefix = data.nodes.find(
      (n) =>
        typeof n.id === 'string' &&
        clusterParam.length >= 8 &&
        (n.id.endsWith(clusterParam) || n.id.includes(clusterParam)),
    );
    if (byIdPrefix) {
      console.debug('[stellar] pickClusterFocusNode: matched by id prefix', {
        clusterParam,
        nodeId: byIdPrefix.id,
      });
      return byIdPrefix;
    }

    // Path 5 — label / subject / object substring (human-readable param).
    const q = clusterParam.toLowerCase();
    const byLabel = data.nodes.find((n) =>
      [n.label, n.subject, n.object].join(" ").toLowerCase().includes(q),
    );
    if (byLabel) {
      console.debug('[stellar] pickClusterFocusNode: matched by label', {
        clusterParam,
        nodeId: byLabel.id,
      });
      return byLabel;
    }
    console.debug(
      '[stellar] pickClusterFocusNode: all entity / id / label paths missed - falling back to most_active',
      { clusterParam },
    );
  }
  // Fallback — pick the cluster with the highest summed degree, then the
  // hottest node inside it. This is the "가장 활발한 클러스터" semantic.
  const degreeByCluster = new Map<number, number>();
  for (const node of data.nodes) {
    const c = node.cluster;
    degreeByCluster.set(c, (degreeByCluster.get(c) ?? 0) + (node.degree ?? 0));
  }
  let bestCluster = data.nodes[0]!.cluster;
  let bestSum = -1;
  for (const [c, sum] of degreeByCluster) {
    if (sum > bestSum) {
      bestSum = sum;
      bestCluster = c;
    }
  }
  let bestNode: StellarNode | null = null;
  for (const n of data.nodes) {
    if (n.cluster !== bestCluster) continue;
    if (!bestNode || (n.degree ?? 0) > (bestNode.degree ?? 0)) {
      bestNode = n;
    }
  }
  return bestNode;
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
// feat/stellar-hover-restore-by-type — floating hover tooltip restored.
//
// History: stellar-zoom-recover (67e3b18) removed BOTH the floating bubble
// AND any hover summary at all. The PO repro on 2026-06-24 confirmed the
// side panel survived but every node read identically on hover ("일렬로
// 텍스트 나열하는 overlay 박스만 남겼네"), so we restore the bubble — but
// instead of one rigid SPO row, we now branch on fact_type and render the
// shape that actually carries the information:
//
//   • action       → `{subject} → {predicate(KO)} → {object}`
//   • claim        → `{speaker} [말함 verb]: {content brief}`
//   • measurement  → `{metric} = {value} {unit} ({as_of})`
//
// Side panel (FocusPanel / STELLAR · FOCUS) is unchanged — click still
// opens the rich detail surface, hover stays a lightweight preview. The
// two surfaces target different intents (hover = peek, click = read).
// ---------------------------------------------------------------------------

interface HoverState {
  node: StellarNode;
  x: number;
  y: number;
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Format a numeric value sensibly for tooltip display:
 *  • integer-looking → no decimal
 *  • non-integer    → up to 2 decimals, trailing zeros stripped */
function formatMeasurementValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return v.toFixed(2).replace(/\.?0+$/, '');
}

interface TooltipLines {
  /** Top accent line (the "who"). */
  head: string;
  /** Middle line — verb / predicate / speech act. */
  mid: string;
  /** Bottom body — the content / object / value+unit. */
  body: string;
  /** Optional footer line (only used by measurement: as_of). */
  foot?: string | null;
}

/** feat/stellar-hover-restore-by-type — branch on fact_type and build
 *  the tooltip's three (or four) display lines. Pure for testability. */
export function tooltipLinesForNode(node: StellarNode): TooltipLines {
  const ft = node.fact_type ?? 'action';

  if (ft === 'claim') {
    const speaker = node.speaker_label?.trim() || node.subject || '(주체 없음)';
    const act = node.speech_act?.trim() || '말함';
    const content =
      node.content_claim?.trim() || node.object || '';
    return {
      head: speaker,
      mid: `[${act}]`,
      body: truncate(content, 90),
    };
  }

  if (ft === 'measurement') {
    const metric = node.metric?.trim() || node.subject || '';
    const value =
      typeof node.measurement_value === 'number'
        ? formatMeasurementValue(node.measurement_value)
        : (node.object || '').trim();
    const unit = node.measurement_unit?.trim() || '';
    const asOf = node.as_of?.trim() || null;
    const valueLine = unit ? `${value} ${unit}`.trim() : value;
    return {
      head: metric,
      mid: '=',
      body: valueLine,
      foot: asOf,
    };
  }

  // action (default) — keep the SPO shape because action facts ARE
  // SPO triples by construction. We render predicate through the KO
  // gloss helper so 'supports' shows as '뒷받침하는 것은' etc.
  return {
    head: node.subject || '',
    mid: `→ ${predicateLabel(node.predicate)} →`,
    body: truncate(node.object, 90),
  };
}

function HoverTooltip({ state }: { state: HoverState | null }) {
  if (!state) return null;
  const { node, x, y } = state;
  const lines = tooltipLinesForNode(node);
  const ft = node.fact_type ?? 'action';
  // fix/stellar-cleanup #9 — predicate-driven theme color for the
  // mid/divider segment of the SPO card and the tooltip's left-border
  // accent. Claim/measurement keep the neutral dim accent (they aren't
  // relation-typed, so their predicate would be misleading).
  const themeColor = ft === 'action' ? predicateThemeColor(node.predicate) : '#9db0b5';
  return (
    <div
      data-testid="stellar-hover-tooltip"
      data-fact-type={ft}
      data-theme-color={themeColor}
      style={{
        position: 'fixed',
        top: y + 14,
        left: x + 14,
        zIndex: 30,
        maxWidth: 340,
        padding: '10px 12px',
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderLeft: `3px solid ${themeColor}`,
        borderRadius: 10,
        color: TEXT_PRIMARY,
        pointerEvents: 'none',
        fontSize: 12,
        lineHeight: 1.45,
        boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
      }}
    >
      <div
        data-testid="stellar-hover-tooltip-head"
        style={{ color: ACCENT, fontWeight: 600 }}
      >
        {lines.head}
      </div>
      <div
        data-testid="stellar-hover-tooltip-mid"
        style={{ color: themeColor, fontSize: 11, marginTop: 2, fontWeight: 600 }}
      >
        {lines.mid}
      </div>
      <div
        data-testid="stellar-hover-tooltip-body"
        style={{ color: TEXT_BODY, marginTop: 4 }}
      >
        {lines.body}
      </div>
      {lines.foot ? (
        <div
          data-testid="stellar-hover-tooltip-foot"
          style={{ color: TEXT_DIM, fontSize: 10, marginTop: 6 }}
        >
          {lines.foot}
        </div>
      ) : null}
    </div>
  );
}



// B-62-v1 — the old FactDrawer (click-to-open detail) has been replaced
// by FocusPanel (click → focus + 1-hop + relation list + chain-navigate).
// See FocusPanel further down.

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

function StatusPill({
  source,
  nodes,
  links,
  focused,
}: {
  source: StellarSource;
  nodes: number;
  links: number;
  focused: StellarNode | null;
}) {
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
      {focused ? (
        <>
          <span style={{ color: TEXT_DIM }}>·</span>
          <span style={{ color: ACCENT }} data-testid="stellar-status-focus">
            focus · deg {focused.degree ?? '·'}
          </span>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// B-62-v1 — edge type legend (top-left). In synthetic mode the four
// relation types are colour-coded so the user knows what they're looking
// at. In real mode we only have entity-link edges today (single accent).
// ---------------------------------------------------------------------------

const EDGE_LABEL_KO: Record<EdgeType, string> = {
  supports: '뒷받침',
  elaborates: '부연',
  causes: '원인',
  contradicts: '반박',
};

// ---------------------------------------------------------------------------
// B-62-search-legibility — top-left search bar.
//
// Matches against node.label + node.subject + node.object (substring,
// case-insensitive). Selecting a result calls onSelect(node), which the
// parent wires into the existing focus handler so the camera flies to
// the node and the side panel opens. Empty input → no-op.
// ---------------------------------------------------------------------------

function SearchBar({
  data,
  onSelect,
}: {
  data: StellarGraphData;
  onSelect: (node: StellarNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const matches = useMemo<StellarNode[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: StellarNode[] = [];
    for (const node of data.nodes) {
      if (out.length >= 10) break;
      const hay = `${node.label} ${node.subject} ${node.object}`.toLowerCase();
      if (!hay.includes(q)) continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node);
    }
    return out;
  }, [query, data]);

  return (
    <div
      data-testid="stellar-search"
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        zIndex: 30,
        width: 280,
        fontFamily: 'Pretendard, sans-serif',
      }}
    >
      <input
        data-testid="stellar-search-input"
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="노드 검색 (subject · object)"
        style={{
          width: '100%',
          padding: '8px 10px',
          background: 'rgba(13,20,23,0.85)',
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 8,
          color: TEXT_PRIMARY,
          fontSize: 13,
          outline: 'none',
        }}
      />
      {open && matches.length > 0 ? (
        <ul
          data-testid="stellar-search-results"
          style={{
            listStyle: 'none',
            padding: 4,
            margin: '6px 0 0',
            background: PANEL_BG,
            border: `1px solid ${PANEL_BORDER}`,
            borderRadius: 8,
            maxHeight: 320,
            overflowY: 'auto',
            backdropFilter: 'blur(8px)',
          }}
        >
          {matches.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                data-testid="stellar-search-result"
                onMouseDown={(e) => {
                  // onMouseDown so the click registers before the input
                  // blur handler closes the dropdown.
                  e.preventDefault();
                  onSelect(node);
                  setQuery('');
                  setOpen(false);
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  padding: '6px 8px',
                  cursor: 'pointer',
                  color: TEXT_BODY,
                  fontSize: 12,
                  display: 'block',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(63,224,198,0.08)';
                  e.currentTarget.style.borderColor = '#244448';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'transparent';
                }}
              >
                <span style={{ color: ACCENT, fontWeight: 600 }}>
                  {node.subject}
                </span>
                <span style={{ color: TEXT_DIM, margin: '0 4px' }}>·</span>
                <span>{node.object}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EdgeLegend({ mode }: { mode: StellarSource }) {
  return (
    <div
      data-testid="stellar-edge-legend"
      style={{
        position: 'absolute',
        // B-62-search-legibility — bumped down so the new SearchBar at
        // top:16 left:16 has clearance. Same column, just stacks below.
        top: 80,
        left: 16,
        zIndex: 10,
        padding: '10px 12px',
        borderRadius: 12,
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        color: TEXT_BODY,
        fontSize: 11,
        letterSpacing: '0.04em',
        fontFamily: 'JetBrains Mono, monospace',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ color: TEXT_DIM, fontSize: 10, marginBottom: 2 }}>
        EDGE · 관계
      </div>
      {mode === 'synthetic' ? (
        (Object.keys(EDGE_LABEL_KO) as EdgeType[]).map((t) => (
          <div
            key={t}
            data-testid={`stellar-edge-legend-${t}`}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span
              style={{
                width: 12,
                height: 2,
                background: EDGE_COLORS[t],
                display: 'inline-block',
                boxShadow: `0 0 6px ${EDGE_COLORS[t]}`,
              }}
            />
            <span>{EDGE_LABEL_KO[t]}</span>
          </div>
        ))
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 12,
              height: 2,
              background: ACCENT,
              display: 'inline-block',
              boxShadow: `0 0 6px ${ACCENT}`,
            }}
          />
          <span>엔티티 링크</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// B-62-v1 — focus panel. Replaces the old FactDrawer. Shows the focused
// fact, its 1-hop relations (clickable to chain-navigate), a back button
// (pops history), and a close button (clears focus entirely). The relation
// rows are colour-coded by edge type and labeled with the Korean relation
// name, mirroring the legend.
// ---------------------------------------------------------------------------

function FocusPanel({
  focused,
  relations,
  historyDepth,
  selected,
  onBack,
  onSelect,
  onExpand,
  onCenter,
  onClose,
}: {
  focused: StellarNode | null;
  relations: FocusRelation[];
  historyDepth: number;
  /** B-62-focus-select-actions — currently inspected sub-node. Drives
   *  the row highlight + the action footer. */
  selected: StellarNode | null;
  onBack: () => void;
  /** Row click — sets selected, NO camera re-centre. */
  onSelect: (node: StellarNode) => void;
  /** 펼치기 action — add the node's 1-hop to the highlight ring. */
  onExpand: (node: StellarNode) => void;
  /** 중심으로 action — promote selected to a new focus (history push). */
  onCenter: (node: StellarNode) => void;
  onClose: () => void;
}) {
  if (!focused) return null;
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
        marginTop: 56,
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
        <span
          style={{ color: ACCENT, fontSize: 11, letterSpacing: '0.08em', fontWeight: 600 }}
        >
          STELLAR · FOCUS
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            data-testid="stellar-focus-back"
            onClick={onBack}
            disabled={historyDepth === 0}
            aria-label="back"
            style={{
              background: historyDepth === 0 ? 'transparent' : 'rgba(63,224,198,0.08)',
              border: `1px solid ${historyDepth === 0 ? '#1a2528' : '#244448'}`,
              color: historyDepth === 0 ? TEXT_DIM : ACCENT,
              borderRadius: 6,
              padding: '2px 8px',
              fontSize: 11,
              cursor: historyDepth === 0 ? 'not-allowed' : 'pointer',
              opacity: historyDepth === 0 ? 0.4 : 1,
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            ← back{historyDepth > 0 ? ` (${historyDepth})` : ''}
          </button>
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
        </div>
      </header>
      <div style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY, lineHeight: 1.5 }}>
        {focused.subject}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: TEXT_DIM }}>
        {predicateLabel(focused.predicate)}
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: TEXT_BODY, lineHeight: 1.6 }}>
        {focused.object}
      </div>
      <div style={{ marginTop: 16, fontSize: 11, color: TEXT_DIM, display: 'flex', gap: 10 }}>
        <span>cluster #{focused.cluster}</span>
        <span>·</span>
        <span>deg {focused.degree ?? '·'}</span>
        <span>·</span>
        <span>vs {(focused.validationStrength ?? 0).toFixed(2)}</span>
      </div>
      {relations.length > 0 ? (
        <div
          data-testid="stellar-focus-relations"
          style={{
            marginTop: 18,
            borderTop: `1px solid ${PANEL_BORDER}`,
            paddingTop: 14,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: TEXT_DIM,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            관계 · {relations.length}
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {relations.slice(0, 50).map((rel, i) => {
              const isRowSelected =
                selected?.id === rel.other.id && selected.id !== focused?.id;
              return (
              <li key={`${rel.other.id}-${i}`}>
                <button
                  type="button"
                  data-testid="stellar-focus-relation-row"
                  data-row-selected={isRowSelected ? 'true' : 'false'}
                  onClick={() => onSelect(rel.other)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    background: isRowSelected
                      ? 'rgba(63,224,198,0.14)'
                      : 'transparent',
                    border: `1px solid ${
                      isRowSelected ? '#3fe0c6' : 'transparent'
                    }`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: TEXT_BODY,
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => {
                    if (isRowSelected) return;
                    e.currentTarget.style.background = 'rgba(63,224,198,0.06)';
                    e.currentTarget.style.borderColor = '#244448';
                  }}
                  onMouseLeave={(e) => {
                    if (isRowSelected) return;
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.borderColor = 'transparent';
                  }}
                >
                  <span
                    title={EDGE_LABEL_KO[rel.type]}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: EDGE_COLORS[rel.type],
                      boxShadow: `0 0 6px ${EDGE_COLORS[rel.type]}`,
                      flex: 'none',
                    }}
                  />
                  <span style={{ color: TEXT_DIM, fontSize: 10, width: 24 }}>
                    {rel.direction === 'out' ? '→' : '←'}
                  </span>
                  {/* B-62-search-legibility — show subject → object so
                   *  "국방부 → 국방부" rows become distinguishable (each
                   *  fact's object_value is different). Display-only
                   *  (canonicalization tracked separately under DR-086). */}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {rel.other.subject}
                    <span style={{ color: TEXT_DIM, margin: '0 4px' }}>→</span>
                    {rel.other.object}
                  </span>
                </button>
              </li>
              );
            })}
            {relations.length > 50 ? (
              <li style={{ color: TEXT_DIM, fontSize: 11, padding: '4px 8px' }}>
                +{relations.length - 50}개 더 (스크롤)
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div style={{ marginTop: 18, color: TEXT_DIM, fontSize: 12 }}>
          이 사실은 다른 사실과 연결되지 않았습니다.
        </div>
      )}
      {/* B-62-focus-select-actions — action footer. Only renders when
       *  selected is set AND is distinct from focused; otherwise the
       *  "selected" concept is collapsed into "focused" and the user
       *  doesn't need separate verbs. */}
      {selected && selected.id !== focused.id ? (
        <div
          data-testid="stellar-focus-actions"
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: `1px solid ${PANEL_BORDER}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: TEXT_DIM,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            선택됨
          </div>
          <div
            data-testid="stellar-focus-selected-summary"
            style={{
              fontSize: 12,
              color: TEXT_PRIMARY,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selected.subject}
            <span style={{ color: TEXT_DIM, margin: '0 4px' }}>→</span>
            {selected.object}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              data-testid="stellar-focus-expand"
              onClick={() => onExpand(selected)}
              style={{
                flex: 1,
                background: 'rgba(63,224,198,0.08)',
                border: '1px solid #244448',
                color: ACCENT,
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'Pretendard, sans-serif',
              }}
            >
              펼치기
            </button>
            <button
              type="button"
              data-testid="stellar-focus-center"
              onClick={() => onCenter(selected)}
              style={{
                flex: 1,
                background: ACCENT,
                border: `1px solid ${ACCENT}`,
                color: '#06080b',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'Pretendard, sans-serif',
              }}
            >
              중심으로
            </button>
          </div>
        </div>
      ) : null}
    </aside>
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
    focusedId?: string | null;
    focusedNeighborIds?: Set<string>;
    selectedId?: string | null;
    viewResetTick?: number;
  }) => React.ReactElement;
  /** Test-mode override for the real-data adapter. */
  realLoader?: () => Promise<StellarGraphData>;
  /** Test-mode override for the synthetic generator. */
  syntheticBuilder?: () => StellarGraphData;
}

export function StellarView(props: StellarViewProps = {}) {
  const [source, setSource] = useState<StellarSource>('synthetic');
  // feat/stellar-hover-restore-by-type — hover state restored. The
  // bubble now branches on fact_type (action / claim / measurement)
  // and renders the shape that carries the info for that kind. Side
  // panel stays the click surface — hover is a lightweight preview.
  const [hovered, setHovered] = useState<HoverState | null>(null);
  // B-62-v1 — focus replaces the old "selected" idea. Focusing a node:
  //   1. dims everything except the node and its 1-hop neighbours,
  //   2. opens the side panel with fact detail + a list of related facts
  //      that the user can click to chain-navigate,
  //   3. pushes the previous focus onto a history stack so "back" works.
  const [focused, setFocused] = useState<StellarNode | null>(null);
  const [focusHistory, setFocusHistory] = useState<StellarNode[]>([]);
  // B-62-focus-select-actions — sub-selection inside the focus subgraph.
  // Relation-row click sets selected (NOT focused); the camera eases
  // lookAt without re-centring. Selected can be promoted to a new
  // focus via the 중심으로 action button.
  const [selected, setSelected] = useState<StellarNode | null>(null);
  // Extra ids added to the highlight set by the 펼치기 action. Keeps
  // the focus subgraph growing as the user explores without losing
  // the anchor. Reset on focus change / focus clear / mode toggle.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // B-62-clear-focus-home-lookat — monotonic counter, bumped whenever
  // the user explicitly leaves a focus subgraph (× close / Esc /
  // source toggle). The renderer reads it as a token to ease the
  // camera's lookAt target back to the scene origin while preserving
  // the user's eye position + orbit + zoom.
  const [viewResetTick, setViewResetTick] = useState(0);
  const [realData, setRealData] = useState<StellarGraphData | null>(null);
  const [realLoading, setRealLoading] = useState(false);
  const realLoadedRef = useRef(false);

  // fix/stellar-cleanup #10 — the cluster auto-focus must wait for
  // localStorage rehydration to complete, otherwise it locks onto the
  // initial synthetic data (default state) before the persisted 'real'
  // mode takes effect. Without this gate, opening /stellar?cluster=…
  // from HOME with a persisted real-mode preference would auto-focus
  // a synthetic node and never re-bind to the real graph.
  // Stored as state (not ref) so the auto-focus effect re-runs when
  // hydration completes — refs alone wouldn't trigger a re-run.
  const [sourceHydrated, setSourceHydrated] = useState(false);

  // Re-hydrate the persisted toggle on mount (no SSR mismatch — useEffect runs client-side only).
  useEffect(() => {
    const persisted = readPersistedSource();
    setSource(persisted);
    setSourceHydrated(true);
  }, []);

  // feat/stellar-hover-restore-by-type — cursor tracking restored.
  // The floating tooltip pins to the cursor (offset by +14px so it
  // doesn't sit under the pointer).
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
    setFocused(null);
    setFocusHistory([]);
    setSelected(null);
    setExpandedIds(new Set());
    // B-62-clear-focus-home-lookat — mode flip is a hard "back to
    // overview" event, so restore the home lookAt too.
    setViewResetTick((t) => t + 1);
  }, []);

  // feat/stellar-hover-restore-by-type — hover restored. The bubble
  // anchors to the cursor (read from cursorRef, updated in the global
  // mousemove effect above). null clears it.
  const handleHover = useCallback((node: StellarNode | null) => {
    if (!node) {
      setHovered(null);
      return;
    }
    setHovered({ node, x: cursorRef.current.x, y: cursorRef.current.y });
  }, []);

  // B-62-v1 — click is now FOCUS. The handler pushes the previous focus
  // onto the history stack (only if it's actually changing — clicking the
  // already-focused node is a no-op for history).
  // B-62-focus-select-actions — focusing also resets selected to the
  // new anchor and clears the expanded set, so the highlight surface
  // matches the new anchor's 1-hop ring exactly.
  const handleClick = useCallback(
    (node: StellarNode) => {
      setFocused((prev) => {
        if (prev && prev.id !== node.id) {
          setFocusHistory((h) => [...h, prev]);
        }
        return node;
      });
      setSelected(node);
      setExpandedIds(new Set());
    },
    [],
  );

  // feat/hearth-oracle-merge + fix/stellar-cluster-focus-recover —
  // auto-focus from /stellar?cluster=<value>.
  //
  // The query param flows from HomePage's "살펴보기 →" link. PO directive:
  // **query param > localStorage preference**. If the user explicitly
  // navigated with `?cluster=`, that intent wins over whatever the
  // persisted source-toggle says — we don't gate on sourceHydrated for
  // synthetic mode (which is the default and always has nodes available).
  //
  // For real mode we still wait for the lazy load to settle (otherwise
  // we'd pick a node from the empty fallback graph and re-fire later).
  // But we no longer wait on `sourceHydrated` itself: synthetic data is
  // built in `useMemo`, available on first render, so binding immediately
  // gives the user the focus they asked for at the URL.
  //
  // Detailed console.debug breadcrumbs help PO trace flow in DevTools.
  const searchParams = useSearchParams();
  const clusterParam = searchParams?.get('cluster') ?? null;
  const clusterAutoFocusedRef = useRef(false);
  useEffect(() => {
    if (!clusterParam) return;
    if (clusterAutoFocusedRef.current) return;

    // Real mode: wait for the lazy load to settle (focus the loaded graph,
    // not the empty placeholder). Synthetic mode is sync — no wait.
    if (source === 'real' && realLoading) {
      console.debug('[stellar] cluster focus: waiting for real load', {
        clusterParam,
        source,
        realLoading,
      });
      return;
    }

    if (activeData.nodes.length === 0) {
      console.debug('[stellar] cluster focus: no nodes yet', {
        clusterParam,
        source,
        nodes: 0,
      });
      return;
    }

    const node = pickClusterFocusNode(activeData, clusterParam);
    if (!node) {
      console.warn('[stellar] cluster focus: pickClusterFocusNode returned null', {
        clusterParam,
        nodes: activeData.nodes.length,
      });
      return;
    }

    clusterAutoFocusedRef.current = true;
    console.debug('[stellar] cluster focus: binding', {
      clusterParam,
      pickedId: node.id,
      pickedSubject: node.subject,
      pickedCluster: node.cluster,
      pickedDegree: node.degree ?? null,
      source,
      sourceHydrated,
    });
    handleClick(node);
  }, [
    clusterParam,
    activeData,
    source,
    realLoading,
    handleClick,
    sourceHydrated,
  ]);

  // B-62-focus-select-actions — relation-row click: set selected only.
  // The camera eases lookAt in StellarGraph; nothing else moves.
  const handleSelect = useCallback((node: StellarNode) => {
    setSelected(node);
  }, []);

  // B-62-focus-select-actions — 펼치기. Adds the given node's 1-hop
  // ring to the expanded set. Held in closure to access the live
  // neighbor index lazily (declared below via useMemo).
  const expandRef = useRef<(node: StellarNode) => void>(() => {});
  const handleExpand = useCallback((node: StellarNode) => {
    expandRef.current(node);
  }, []);

  // B-62-v1 — focus pop / clear handlers.
  const handleBack = useCallback(() => {
    setFocusHistory((h) => {
      if (h.length === 0) {
        setFocused(null);
        return h;
      }
      const next = h.slice(0, -1);
      setFocused(h[h.length - 1] ?? null);
      setSelected(h[h.length - 1] ?? null);
      setExpandedIds(new Set());
      return next;
    });
  }, []);
  const handleClearFocus = useCallback(() => {
    setFocused(null);
    setFocusHistory([]);
    setSelected(null);
    setExpandedIds(new Set());
    // B-62-clear-focus-home-lookat — bump the reset tick so the
    // renderer eases lookAt back to the home origin while keeping
    // the user's eye position + orbit + wheel zoom intact. Fires for
    // both × close and Escape (Esc calls this same handler below).
    setViewResetTick((t) => t + 1);
  }, []);

  // B-62-v1 — Esc clears focus. Convenient escape hatch from a deep
  // chain navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        handleClearFocus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClearFocus]);

  const Renderer = props.renderer ?? StellarGraphLazy;

  const realIsEmpty = source === 'real' && !realLoading && activeData.nodes.length === 0;

  // B-62-v1 — neighbour index for the current data set. Built once per
  // activeData reference; the lookup is O(1) for the renderer's hot path.
  // For each link we record both endpoints' counterparts; the resulting
  // map answers "what are X's 1-hop neighbours?" in constant time.
  const neighborIndex = useMemo(() => {
    const idx = new Map<string, Set<string>>();
    const push = (a: string, b: string) => {
      let s = idx.get(a);
      if (!s) {
        s = new Set();
        idx.set(a, s);
      }
      s.add(b);
    };
    for (const link of activeData.links) {
      const src =
        typeof link.source === 'string'
          ? link.source
          : (link.source as { id?: string } | null)?.id ?? '';
      const tgt =
        typeof link.target === 'string'
          ? link.target
          : (link.target as { id?: string } | null)?.id ?? '';
      if (!src || !tgt) continue;
      push(src, tgt);
      push(tgt, src);
    }
    return idx;
  }, [activeData]);

  // B-62-v1 — 1-hop relations for the focused node, materialised for the
  // side panel. Each relation carries the edge type (colour) + the other-
  // end node (clickable to chain-navigate). Empty when nothing is focused.
  // B-62-focus-select-actions — union the 1-hop ring with anything the
  // user has 펼치기-ed so the highlight grows incrementally.
  const focusedNeighborIds = useMemo<Set<string>>(() => {
    if (!focused) return new Set();
    const base = neighborIndex.get(focused.id) ?? new Set<string>();
    if (expandedIds.size === 0) return base;
    const out = new Set<string>(base);
    for (const id of expandedIds) out.add(id);
    return out;
  }, [focused, neighborIndex, expandedIds]);

  // B-62-focus-select-actions — bind the lazy expand closure now that
  // we have the live neighborIndex. The 펼치기 button calls handleExpand
  // → expandRef.current → this, which unions the node's 1-hop into the
  // expanded set without disturbing focus.
  useEffect(() => {
    expandRef.current = (node: StellarNode) => {
      const ring = neighborIndex.get(node.id);
      if (!ring || ring.size === 0) return;
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(node.id);
        for (const id of ring) next.add(id);
        return next;
      });
    };
  }, [neighborIndex]);
  const focusRelations = useMemo<FocusRelation[]>(() => {
    if (!focused) return [];
    const out: FocusRelation[] = [];
    const byId = new Map(activeData.nodes.map((n) => [n.id, n] as const));
    for (const link of activeData.links) {
      const src =
        typeof link.source === 'string'
          ? link.source
          : (link.source as { id?: string } | null)?.id ?? '';
      const tgt =
        typeof link.target === 'string'
          ? link.target
          : (link.target as { id?: string } | null)?.id ?? '';
      let other: string | null = null;
      let direction: 'out' | 'in' | null = null;
      if (src === focused.id) {
        other = tgt;
        direction = 'out';
      } else if (tgt === focused.id) {
        other = src;
        direction = 'in';
      } else {
        continue;
      }
      const otherNode = other ? byId.get(other) : null;
      if (!otherNode) continue;
      out.push({ type: link.type, direction: direction!, other: otherNode });
    }
    return out;
  }, [focused, activeData]);

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
          focusedId={focused?.id ?? null}
          focusedNeighborIds={focusedNeighborIds}
          selectedId={selected?.id ?? null}
          viewResetTick={viewResetTick}
        />
      </div>

      <SourceToggle source={source} onChange={handleToggle} />
      {/* B-62-search-legibility — search wires straight into handleClick
       *  so selection enters the existing focus mode (camera fly-to from
       *  StellarGraph + 1-hop dim + side panel + relations chain). */}
      <SearchBar data={activeData} onSelect={handleClick} />
      <EdgeLegend mode={source} />

      {realIsEmpty ? <ColdStartHint /> : null}

      <StatusPill
        source={source}
        nodes={activeData.nodes.length}
        links={activeData.links.length}
        focused={focused}
      />

      <HoverTooltip state={hovered} />
      <FocusPanel
        focused={focused}
        relations={focusRelations}
        historyDepth={focusHistory.length}
        selected={selected}
        onBack={handleBack}
        onSelect={handleSelect}
        onExpand={handleExpand}
        onCenter={handleClick}
        onClose={handleClearFocus}
      />
    </div>
  );
}

export default StellarView;
