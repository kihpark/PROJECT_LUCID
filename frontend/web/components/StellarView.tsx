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
import { generateSyntheticGraph } from '@/lib/syntheticGraph';
import type { StellarGraphData, StellarLink, StellarNode } from '@/lib/syntheticGraph';
import { emptyStellarGraph, loadRealStellarGraph } from '@/lib/stellarRealAdapter';
import { predicateLabel } from '@/lib/predicateLabels';
import {
  StellarLeftPanel,
  type EntityBucket,
} from './StellarLeftPanel';
// M3-2d interactions — single SPO hover card + entity card + edge facts list.
// ★ PO 의뢰서 verbatim. 중복 오버레이 0.
// fix/stellar-cards-entity-node-compat — pickEntityName shared so the
// in-canvas tooltip never falls back to '(주체 없음)'.
import { StellarHoverCard, pickEntityName } from './StellarHoverCard';
import { StellarEntityCard } from './StellarEntityCard';
import { StellarEdgeFactsList } from './StellarEdgeFactsList';
// ★ L1 / L4 (STELLAR legend/shape/hover, PO 2026-06-29):
//   L1 = STELLAR LEGEND (color + shape vocabulary 안내)
//   L4 = edge hover tooltip (predicate only)
import { StellarLegend } from './StellarLegend';
import { StellarEdgeHoverTooltip } from './StellarEdgeHoverTooltip';
// ★ V4 (fix/stellar-v1-v2-v4-legend-class, PO 2026-06-29) — SearchBar
//   자동완성 결과에 의미 없는 라벨 (".", "...", 공백, 구두점만) 0. 옛 fix
//   (api.ts::isMeaningfulLabel) 가 RecallView 의 /entities/suggest 응답만
//   걸렀고, STELLAR SearchBar 의 in-memory match path 는 따로 살아 있어
//   PO 가 "라온프렌즈" 검색 시 "." 추천을 다시 봤다 (image #88). 같은
//   filter 를 SearchBar 에도 적용해 회귀를 닫는다.
import { isMeaningfulLabel } from '@/lib/api';

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

/** ★ W3 (STELLAR 6-class fix, 2026-06-29) — single-bucket entity-type map.
 *  Old behaviour: `null/undefined` → all 3 buckets (legacy guard). That made
 *  unknown-type WHO entities persist after WHO was unchecked — the WHERE
 *  필터 → person 잔존 violation class.
 *
 *  New behaviour:
 *    person / organization / group           → who
 *    product / resource / concept / knowledge → what
 *    event / artifact                         → what
 *    place / location / region / venue        → where
 *    others / null / undefined                → 'unknown' (filter passes
 *                                                them through unless ALL
 *                                                bucket toggles are off).
 *  Pure helpers for tests. */
export const ENTITY_TYPE_TO_BUCKET: Record<string, 'who' | 'what' | 'where'> = {
  person: 'who',
  organization: 'who',
  group: 'who',
  product: 'what',
  resource: 'what',
  concept: 'what',
  knowledge: 'what',
  event: 'what',
  artifact: 'what',
  place: 'where',
  location: 'where',
  region: 'where',
  venue: 'where',
};

export function entityBucketForSingle(
  entityType: string | null | undefined,
): 'who' | 'what' | 'where' | 'unknown' {
  if (!entityType) return 'unknown';
  const t = entityType.toLowerCase();
  return ENTITY_TYPE_TO_BUCKET[t] ?? 'unknown';
}

/** Backward-compat: returns a Set. Known types → single-element Set,
 *  'unknown' → empty Set (caller decides how to treat). */
export function entityBucketFor(
  entityType: string | null | undefined,
): Set<EntityBucket> {
  const b = entityBucketForSingle(entityType);
  if (b === 'unknown') return new Set();
  return new Set([b]);
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


// fix/stellar-cluster-focus-race-fix (2026-06-26): one-shot migration of
// stale 'synthetic' localStorage values written by the pre-d017a3a
// default. PO 의 첫 방문 시점에 synthetic 이 default 였고 localStorage
// 에 'synthetic' 이 명시 set 됐을 가능 → 이후 default 가 real 로 바뀌어도
// localStorage 의 명시값이 우선해 synthetic 으로 떨어졌음. v2 migration
// 은 첫 한 번만 옛 'synthetic' 을 무효화하여 real 진입을 풀어준다.
// 사용자가 toggle 로 의도적으로 'synthetic' 을 다시 켜면 그 시점부터의
// 명시값은 보존된다 (v2 marker 가 set 된 후 기록 된 것이기 때문).
const LS_MIGRATION_KEY = `${LS_KEY}:migrated:v2`;

function readPersistedSource(): StellarSource {
  // fix/stellar-default-real (2026-06-26): default = 'real' on first
  // visit. PO 의 살펴보기 흐름이 synthetic 모드로 떨어져 IPCC sample
  // 노드 만 보였음. localStorage 에 'synthetic' 명시된 경우만 synthetic
  // (사용자가 toggle 후 의도 보존), 그 외 모두 real.
  if (typeof window === 'undefined') return 'real';
  try {
    // fix/stellar-cluster-focus-race-fix — one-shot v2 migration. Clears
    // stale 'synthetic' written before d017a3a. Runs at most once per
    // browser; subsequent reads honour the user's explicit toggle.
    if (!window.localStorage.getItem(LS_MIGRATION_KEY)) {
      window.localStorage.removeItem(LS_KEY);
      window.localStorage.setItem(LS_MIGRATION_KEY, '1');
      console.debug('[stellar] readPersistedSource: v2 migration applied, clearing stale source key');
      return 'real';
    }
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

  // fix/stellar-cards-entity-node-compat — v2 entity / claim nodes carry the
  // name on `label` (or related fields) instead of `subject`. Route every
  // missing-subject fallback through pickEntityName so the in-canvas tooltip
  // never displays the stale '(주체 없음)' string.
  if (ft === 'claim') {
    const speaker = node.speaker_label?.trim() || pickEntityName(node);
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
    const metric = node.metric?.trim() || pickEntityName(node);
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
    head: node.subject?.trim() ? node.subject : pickEntityName(node),
    mid: `→ ${predicateLabel(node.predicate ?? '')} →`,
    body: truncate(node.object, 90),
  };
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
      <div style={{ fontSize: 14, color: ACCENT, letterSpacing: '0.08em' }}>지식그래프 · 비어 있음</div>
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
// fix/stellar-remove-old-edge-panel - B-62-v1's EdgeLegend (synthetic
// "EDGE / 관계" key + real-mode "엔티티 링크" single-line) was
// removed when M3-2c StellarLeftPanel arrived; the dead EdgeLegend
// function + its EDGE_LABEL_KO map are now cleaned up too so the build
// stays warning-free (PO 2026-06-28 좌패널 단순화 작업의 부수 정리).
// M3-2b ENTITY_COLORS + edgeStyleFor remain the single visual-vocab
// source for both modes; nothing references EDGE_LABEL_KO any more.
// ---------------------------------------------------------------------------

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
      // ★ V4 (fix/stellar-v1-v2-v4-legend-class, PO 2026-06-29) — drop
      // suggestion entries whose primary label is meaningless (".",
      // "...", whitespace, pure punctuation). Mirrors api.ts::isMeaningfulLabel
      // so RecallView 와 STELLAR SearchBar 가 같은 의미-없는 라벨 가드를
      //공유한다. 원칙 단위 — 특정 케이스 ("." / "라온프렌즈") 하드코딩 X.
      // The check also covers subject + object so a node whose label is
      // valid but whose only matchable surface text is meaningless does
      // not surface either.
      const primary = node.label ?? node.subject ?? node.object ?? '';
      if (!isMeaningfulLabel(primary)) continue;
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

export interface StellarViewProps {
  /** Test-mode override: swap the renderer for a mock component. The
   *  vitest jsdom environment can't run three.js. */
  renderer?: (props: {
    data: StellarGraphData;
    mode: StellarSource;
    onNodeHover?: (n: StellarNode | null) => void;
    onNodeClick?: (n: StellarNode) => void;
    /** M3-2d — edge-click handler. Receives the two endpoint nodes.
     *  fix/stellar-cards-entity-node-compat — optional `link` carries the
     *  v2 StellarLink so the EdgeFactsList can render link-derived summary
     *  (predicates / fact_count / roles / link_status). The existing mock
     *  renderer in tests only passes {a, b} — link is opt-in. */
    onLinkClick?: (
      endpoints: { a: StellarNode; b: StellarNode },
      link?: StellarLink,
    ) => void;
    /** ★ L4 (PO 2026-06-29) — edge hover callback. fires when cursor
     *  enters / leaves a link. The parent renders StellarEdgeHoverTooltip
     *  with the predicate label only. */
    onLinkHover?: (link: StellarLink | null) => void;
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
  // fix/stellar-cluster-focus-race-fix — initial source seeded by reading
  // localStorage synchronously inside the lazy initial-state callback.
  // The previous default ('synthetic') caused a one-frame window where
  // the cluster-focus useEffect saw synthetic data even when the user's
  // persisted choice was 'real'. That stale frame latched syn-3-100
  // into `focused`, then `clusterAutoFocusedRef` blocked any re-bind
  // when real data arrived → "IPCC supports +1.5℃" stuck on screen +
  // 'focused node not in data' warnings.
  //
  // useState's lazy initializer is allowed to read localStorage in a
  // Client Component (the file is 'use client'). On SSR the typeof
  // window guard inside readPersistedSource() returns 'real', which
  // is also what the hydration pass converges to — so no mismatch.
  const [source, setSource] = useState<StellarSource>(() => readPersistedSource());
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
  // B-62-focus-select-actions — sub-selection inside the focus subgraph.
  // Relation-row click sets selected (NOT focused); the camera eases
  // lookAt without re-centring. Selected can be promoted to a new
  // focus via the 중심으로 action button.
  const [selected, setSelected] = useState<StellarNode | null>(null);
  // Extra ids added to the highlight set by the 펼치기 action. Keeps
  // the focus subgraph growing as the user explores without losing
  // the anchor. Reset on focus change / focus clear / mode toggle.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // M3-2c — "발언(CLAIM) 보기" toggle. ★ N1 (STELLAR 6-class fix,
  // 2026-06-29 PO): default flipped to ON. CLAIM 노드는 default
  // 가시이며, 사용자가 명시적으로 숨김을 누르면 hide. PO 의 dogfood
  // 흐름에서 발언 노드가 안 보여 fact_type 균형이 무너졌던 violation
  // 클래스를 닫는다.
  const [showClaims, setShowClaims] = useState(true);

  // fix/stellar-leftpanel-simplify (2026-06-28 PO) — left-panel reduced
  // to ENTITY only. Old fact_type / as_of / link_status state removed
  // (the UI no longer surfaces them). Data fields on nodes/links are
  // preserved untouched — this is a UI-only simplification.
  //
  // fix/stellar-ux-self-audit U2 — `unknown` is now a first-class bucket
  // alongside who/what/where. Entity nodes with missing or unmapped
  // entity_type used to pass the filter regardless of the three known
  // toggles, leaving no user control surface for them. Default ON so the
  // existing visual behaviour (unknown surfaces) is preserved until the
  // user explicitly hides them.
  const [entityBuckets, setEntityBuckets] = useState<Record<EntityBucket, boolean>>({
    who: true,
    what: true,
    where: true,
    unknown: true,
  });
  // B-62-clear-focus-home-lookat — monotonic counter, bumped whenever
  // the user explicitly leaves a focus subgraph (× close / Esc /
  // source toggle). The renderer reads it as a token to ease the
  // camera's lookAt target back to the scene origin while preserving
  // the user's eye position + orbit + zoom.
  const [viewResetTick, setViewResetTick] = useState(0);
  // M3-2d — 엣지 클릭 상태. null 이면 entity 카드 (focused) 가 보인다.
  // fix/stellar-cards-entity-node-compat — optional `link` carries the v2
  // StellarLink object so the EdgeFactsList summary path can render it.
  const [edgeClick, setEdgeClick] = useState<{
    a: StellarNode;
    b: StellarNode;
    link?: StellarLink;
  } | null>(null);
  // ★ L4 (STELLAR legend/shape/hover, PO 2026-06-29) — edge hover state.
  //   null 이면 tooltip 미표시. predicate 만 보여주고 click 은 별도 동작
  //   (EdgeFactsList) 으로 분리 — hover 와 click 이 다른 surface 다.
  const [edgeHover, setEdgeHover] = useState<{
    link: StellarLink;
    x: number;
    y: number;
  } | null>(null);
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

  // fix/stellar-cluster-focus-race-fix — source itself is now seeded
  // from localStorage by the useState lazy initializer above, so the
  // post-mount setSource() is gone. We still flip sourceHydrated on
  // mount so the cluster-focus useEffect can distinguish the SSR
  // shell (no localStorage access) from the hydrated client render.
  useEffect(() => {
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

  // M3-2c — apply layer toggle + left-panel filters to activeData.
  // All filters are pure data filters (★ no visual style binding).
  // Order matters only for the link-side filters: we collect the set
  // of surviving node ids first, then drop links that point at a
  // removed node (so the renderer never receives dangling edges).
  const filteredData = useMemo<StellarGraphData>(() => {
    let nodes = activeData.nodes;
    let links = activeData.links;

    // CLAIM toggle: OFF → hide claim nodes + 'claimed' links entirely.
    // ★ This is HIDE (filter out), NOT a visual dim — the 2026-06-28
    // PO correction explicitly rejected opacity/blur for the toggle.
    // ★ link_status / fact_type FIELDS on the data are preserved
    // (data-layer untouched per fix/stellar-leftpanel-simplify directive);
    // only the UI filters have been simplified away.
    // ★ N1 (2026-06-29 PO): the toggle defaults to ON now, so this branch
    // only runs when the user has explicitly hidden claims.
    if (!showClaims) {
      nodes = nodes.filter(
        (n) => n.kind !== 'claim' && (n.fact_type ?? 'action') !== 'claim',
      );
      links = links.filter((l) => (l.link_status ?? 'verified') !== 'claimed');
    }

    // ★ W3 (STELLAR 6-class fix, 2026-06-29) +
    // fix/stellar-ux-self-audit U2 — entity-bucket filter.
    //
    // Rules:
    //   • CLAIM 노드 (kind === 'claim' OR fact_type === 'claim') 는 bucket
    //     필터를 받지 않는다 — showClaims 토글만 따른다.
    //   • Known-bucket entity 노드 (who/what/where) 는 해당 토글이 켜져
    //     있어야 surface.
    //   • Unknown 버킷 entity 노드 (entity_type missing or unmapped) 는
    //     entityBuckets.unknown 토글이 켜져 있어야 surface — 옛 동작
    //     (항상 surface) 은 사용자가 끌 수 없는 violation 이었다.
    //
    // U2 fix: `unknown` is now a first-class user-controlled bucket; turning
    // it off hides every entity node with a missing/unmapped entity_type.
    const allBucketsOff =
      !entityBuckets.who &&
      !entityBuckets.what &&
      !entityBuckets.where &&
      !entityBuckets.unknown;
    if (allBucketsOff) {
      nodes = [];
    } else if (
      !(
        entityBuckets.who &&
        entityBuckets.what &&
        entityBuckets.where &&
        entityBuckets.unknown
      )
    ) {
      nodes = nodes.filter((n) => {
        // CLAIM 노드는 통과 — showClaims 가 이미 위에서 분기.
        if (n.kind === 'claim' || n.fact_type === 'claim') return true;
        const b = entityBucketForSingle(n.entity_type);
        // U2: unknown 도 user-controlled. 옛 동작은 ‘unknown 항상 통과’ →
        // 사용자가 토글로 끄지 못함.
        return entityBuckets[b];
      });
    }

    // Drop links that point at a node we filtered out.
    if (nodes.length !== activeData.nodes.length) {
      const ids = new Set(nodes.map((n) => n.id));
      links = links.filter((l) => {
        const src =
          typeof l.source === 'string'
            ? l.source
            : (l.source as { id?: string } | null)?.id ?? '';
        const tgt =
          typeof l.target === 'string'
            ? l.target
            : (l.target as { id?: string } | null)?.id ?? '';
        return ids.has(src) && ids.has(tgt);
      });
    }

    return { nodes, links, clusters: activeData.clusters };
  }, [activeData, showClaims, entityBuckets]);

  const handleToggle = useCallback((next: StellarSource) => {
    setSource(next);
    persistSource(next);
    setHovered(null);
    setFocused(null);
    setSelected(null);
    setExpandedIds(new Set());
    setEdgeClick(null);
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

  // ★ L4 (PO 2026-06-29) — edge hover handler. predicate-only tooltip.
  const handleLinkHover = useCallback((link: StellarLink | null) => {
    if (!link) {
      setEdgeHover(null);
      return;
    }
    setEdgeHover({
      link,
      x: cursorRef.current.x,
      y: cursorRef.current.y,
    });
  }, []);

  // B-62-v1 — click is now FOCUS. The handler pushes the previous focus
  // onto the history stack (only if it's actually changing — clicking the
  // already-focused node is a no-op for history).
  // B-62-focus-select-actions — focusing also resets selected to the
  // new anchor and clears the expanded set, so the highlight surface
  // matches the new anchor's 1-hop ring exactly.
  const handleClick = useCallback(
    (node: StellarNode) => {
      setFocused(node);
      setSelected(node);
      setExpandedIds(new Set());
      // M3-2d — 노드 클릭은 엣지 카드를 닫는다 (둘 중 하나만 활성).
      setEdgeClick(null);
    },
    [],
  );

  // feat/hearth-oracle-merge + fix/stellar-cluster-focus-recover +
  // fix/stellar-cluster-focus-race-fix — auto-focus from
  // /stellar?cluster=<value>.
  //
  // The query param flows from HomePage's "살펴보기 →" link.
  //
  // Race condition history (root cause of PO 2026-06-26 repro):
  //   1. Pre-fix initial state was source='synthetic'; the first render
  //      had syntheticData ready and the cluster-focus useEffect latched
  //      onto syn-3-100.
  //   2. Mount useEffect then flipped source to 'real' (per localStorage).
  //   3. Real data loaded; activeData switched. But `focused` still held
  //      the stale syn-3-100 node — the FocusPanel kept showing "IPCC
  //      supports +1.5℃" and StellarGraph's fly-to logged
  //      "focused node not in data" five times in a row.
  //
  // Two-part fix:
  //   • Source is now seeded synchronously from localStorage (useState
  //     lazy initializer above), so the synthetic transient is gone.
  //   • A dedicated effect (below) clears stale focus + resets the
  //     cluster-focus latch whenever `source` flips, so any user toggle
  //     from REAL→SYNTHETIC (or vice-versa) re-binds cluster focus
  //     against the new data and never leaks an id from the old mode.
  //
  // For real mode we still wait for the lazy load to settle (otherwise
  // we'd pick a node from the empty fallback graph and re-fire later).
  //
  // Detailed console.debug breadcrumbs help PO trace flow in DevTools.
  const searchParams = useSearchParams();
  const clusterParam = searchParams?.get('cluster') ?? null;
  const clusterAutoFocusedRef = useRef(false);

  // fix/stellar-cluster-focus-race-fix — source-change guard.
  //
  // When `source` toggles (REAL↔SYNTHETIC) we MUST reset the
  // cluster-focus latch and drop any stale `focused` node — its id
  // belongs to the previous data set and would feed the fly-to
  // useEffect a node id that no longer exists, producing the
  // 'focused node not in data' console warnings PO saw.
  //
  // The handleToggle callback already does this for explicit user
  // clicks, but the initial mount path (source seeded sync from
  // localStorage, then activeData lands later for real mode) doesn't
  // route through handleToggle. This effect closes that gap and is
  // also the recovery mechanism for the second-and-later toggle.
  //
  // We deliberately use a ref to skip the very first run — on mount
  // there is nothing to clear, and skipping prevents the cluster
  // focus useEffect from racing this one to set/clear focus.
  const prevSourceRef = useRef<StellarSource | null>(null);
  useEffect(() => {
    if (prevSourceRef.current === null) {
      prevSourceRef.current = source;
      return;
    }
    if (prevSourceRef.current === source) return;
    console.debug('[stellar] source change: resetting cluster focus latch', {
      from: prevSourceRef.current,
      to: source,
    });
    prevSourceRef.current = source;
    clusterAutoFocusedRef.current = false;
    setFocused(null);
    setSelected(null);
    setExpandedIds(new Set());
  }, [source]);

  useEffect(() => {
    if (!clusterParam) return;
    if (clusterAutoFocusedRef.current) return;
    if (!sourceHydrated) {
      // Without hydration we don't know yet whether the user prefers
      // real — picking on the SSR-default synthetic data would be the
      // race we are trying to kill. Wait one tick.
      console.debug('[stellar] cluster focus: awaiting source hydration', {
        clusterParam,
        source,
      });
      return;
    }

    // Real mode: wait for the lazy load to settle (focus the loaded graph,
    // not the empty placeholder, and not stale synthetic data either).
    // Synthetic mode is sync — no wait.
    if (source === 'real' && (realLoading || realData === null)) {
      console.debug('[stellar] cluster focus: waiting for real load', {
        clusterParam,
        source,
        realLoading,
        realDataReady: realData !== null,
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

    console.debug('[stellar] cluster focus: resolving', {
      clusterParam,
      source,
      realLoading,
      nodes: activeData.nodes.length,
    });

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
    realData,
    handleClick,
    sourceHydrated,
  ]);



  const handleClearFocus = useCallback(() => {
    setFocused(null);
    setSelected(null);
    setExpandedIds(new Set());
    setEdgeClick(null);
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
    for (const link of filteredData.links) {
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
  }, [filteredData]);

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
          data={filteredData}
          mode={source}
          onNodeHover={handleHover}
          onNodeClick={handleClick}
          onLinkClick={(endpoints, link) => {
            // M3-2d — 엣지 클릭. focus 는 그대로 두고 edgeClick state 만 set.
            // (focused 와 edgeClick 이 둘 다 truthy 일 때 EdgeFactsList 가 우선.)
            // fix/stellar-cards-entity-node-compat — v2 link 객체가 함께 오면
            // 보존했다가 EdgeFactsList 로 전달.
            setEdgeClick(link ? { ...endpoints, link } : endpoints);
          }}
          onLinkHover={handleLinkHover}
          focusedId={focused?.id ?? null}
          focusedNeighborIds={focusedNeighborIds}
          selectedId={selected?.id ?? null}
          viewResetTick={viewResetTick}
        />
      </div>

      <SourceToggle source={source} onChange={handleToggle} />
      {/* M3-2c — "발언(CLAIM) 보기" toggle. Off by default → skeleton
        * view (entity + action edges). ★ Off = HIDE claim nodes
        * (filter out), NOT a visual dim (per 2026-06-28 PO correction). */}
      <button
        type="button"
        data-testid="stellar-claim-toggle"
        aria-pressed={showClaims}
        onClick={() => setShowClaims((v) => !v)}
        style={{
          position: 'absolute',
          top: 60,
          right: 18,
          zIndex: 10,
          padding: '6px 14px',
          borderRadius: 999,
          border: `1px solid ${showClaims ? '#3fe0c6' : '#1c272b'}`,
          background: showClaims
            ? 'color-mix(in oklab, #3fe0c6 18%, transparent)'
            : 'rgba(12,19,22,0.92)',
          color: showClaims ? '#3fe0c6' : '#cdd9da',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          letterSpacing: '0.04em',
          backdropFilter: 'blur(8px)',
          fontFamily: 'Pretendard, sans-serif',
        }}
      >
        발언 {showClaims ? '숨김' : '보기'}
      </button>

      <StellarLeftPanel
        entityBuckets={entityBuckets}
        onEntityBucketChange={(b, c) =>
          setEntityBuckets((prev) => ({ ...prev, [b]: c }))
        }
      />
      {/* B-62-search-legibility — search wires straight into handleClick
       *  so selection enters the existing focus mode (camera fly-to from
       *  StellarGraph + 1-hop dim + side panel + relations chain). */}
      <SearchBar data={filteredData} onSelect={handleClick} />
      {/* fix/stellar-remove-old-edge-panel (PO 2026-06-28):
       *   옛 EdgeLegend ("EDGE · 관계" / "엔티티 링크") 폐기.
       *   fix/stellar-leftpanel-simplify (2026-06-28 PO 명령): 좌패널은
       *   ENTITY 토글 만 담당. fact_type 분기는 우상단 CLAIM 토글이,
       *   M3-2b 의 ENTITY_COLORS + edgeStyleFor 가 시각 어휘를 담는다. */}

      {realIsEmpty ? <ColdStartHint /> : null}

      <StatusPill
        source={source}
        nodes={filteredData.nodes.length}
        links={filteredData.links.length}
        focused={focused}
      />

      {/* ★ L1 (PO 2026-06-29) — STELLAR LEGEND. default visible, user can
       *  collapse. 색·형태 어휘 안내.
       *  ★ V1++ (fix/stellar-v1-v2-v4-legend-class, PO 2026-06-29) — pass
       *  the currently-visible nodes so each LEGEND row carries its
       *  "(count)" — 사용자가 그래프의 분포 즉시 파악. */}
      <StellarLegend nodes={filteredData.nodes} />

      {hovered ? (
        <StellarHoverCard fact={hovered.node} position={{ x: hovered.x, y: hovered.y }} />
      ) : null}
      {/* ★ L4 (PO 2026-06-29) — edge hover tooltip. predicate label only. */}
      {edgeHover ? (
        <StellarEdgeHoverTooltip
          predicate={edgeHover.link.predicate ?? null}
          predicates={edgeHover.link.predicates ?? null}
          position={{ x: edgeHover.x, y: edgeHover.y }}
        />
      ) : null}
      {/* M3-2d — 노드 클릭 → entity 카드 (의뢰서 verbatim). FocusPanel
       *  로직 (relations, expand, history) 은 highlight ring 을 위해
       *  state 로 보존하되, 시각 surface 는 EntityCard 로 교체. */}
      {focused && !edgeClick ? (
        <StellarEntityCard
          entity={focused}
          allFacts={activeData.nodes}
          links={activeData.links}
          onClose={handleClearFocus}
        />
      ) : null}
      {/* M3-2d — 엣지 클릭 → fact 리스트. */}
      {edgeClick ? (
        <StellarEdgeFactsList
          endpoints={{ a: edgeClick.a, b: edgeClick.b }}
          allFacts={activeData.nodes}
          link={edgeClick.link}
          onClose={() => setEdgeClick(null)}
        />
      ) : null}
      {/* ★ W1 (STELLAR 6-class fix, 2026-06-29) — Playwright e2e hook.
       *  3D canvas 엣지 클릭은 Playwright 가 안정적으로 reproduce 할 수
       *  없다 (force-graph-3d → three.js raycast). 이 hidden button 은
       *  display:none 으로 사용자에게 안 보이지만 testid 로 fire 가능 →
       *  e2e 가 edgeClick state 를 발화시켜 StellarEdgeFactsList 가
       *  실제 production 경로 (setEdgeClick) 를 지나도록 한다.
       *
       *  Production 영향 0 (display:none, 사용자 노출 X).
       *  data.links 가 비어 있으면 noop 으로 graceful 처리. */}
      <button
        type="button"
        data-testid="stellar-e2e-fire-edge-click"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => {
          const ns = filteredData.nodes;
          const ls = filteredData.links;
          if (ns.length === 0 || ls.length === 0) return;
          const link = ls[0];
          if (!link) return;
          const srcId =
            typeof link.source === 'string'
              ? link.source
              : (link.source as { id?: string } | null)?.id ?? '';
          const tgtId =
            typeof link.target === 'string'
              ? link.target
              : (link.target as { id?: string } | null)?.id ?? '';
          const fallback = ns[0];
          if (!fallback) return;
          const a = ns.find((n) => n.id === srcId) ?? fallback;
          const b = ns.find((n) => n.id === tgtId) ?? ns[1] ?? fallback;
          setEdgeClick({ a, b, link });
        }}
        style={{ display: 'none' }}
      >
        e2e: fire edge click
      </button>
      {/* ★ L4 (PO 2026-06-29) — e2e hover hook. The 3D canvas onLinkHover
       *  raycast is unreliable in Playwright (force-graph-3d → three.js).
       *  This hidden button fires the same handler the production canvas
       *  drives so the e2e can prove the tooltip path renders correctly.
       *  display:none → 사용자 노출 0. */}
      <button
        type="button"
        data-testid="stellar-e2e-fire-edge-hover"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => {
          const ls = filteredData.links;
          if (ls.length === 0) return;
          const link = ls[0];
          if (!link) return;
          setEdgeHover({
            link,
            x: cursorRef.current.x || 200,
            y: cursorRef.current.y || 200,
          });
        }}
        style={{ display: 'none' }}
      >
        e2e: fire edge hover
      </button>
      {/* ★ L3 (PO 2026-06-29) — e2e hover hook for a CLAIM node. Playwright
       *  cannot reliably hover the 3D canvas raycast; this button fires the
       *  exact same handleHover path the production canvas drives, picking
       *  the first claim node in filteredData. display:none — production
       *  surface impact 0. */}
      <button
        type="button"
        data-testid="stellar-e2e-fire-claim-hover"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => {
          const ns = filteredData.nodes;
          const claim = ns.find(
            (n) => n.kind === 'claim' || n.fact_type === 'claim',
          );
          if (!claim) return;
          handleHover(claim);
        }}
        style={{ display: 'none' }}
      >
        e2e: fire claim hover
      </button>
      <button
        type="button"
        data-testid="stellar-e2e-clear-edge-hover"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setEdgeHover(null)}
        style={{ display: 'none' }}
      >
        e2e: clear edge hover
      </button>
    </div>
  );
}

export default StellarView;
