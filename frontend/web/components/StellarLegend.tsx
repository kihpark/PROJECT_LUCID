/**
 * ★ L1 (STELLAR legend/shape/hover, PO 2026-06-29) — STELLAR LEGEND.
 * ★ fix/stellar-v1-v2-v4-legend-class (PO 2026-06-29) — V1 / V1+ / V1++ / V2
 *   동기화 fix.
 *
 * 위반 클래스 (★ PO verbatim):
 *   V1.  WHO/사람 vs unknown 시각 동일 → 양쪽 모두 sphere/teal 이라 분포
 *        디버그 시 unknown 노드를 사람 노드와 혼동.
 *   V1+. WHAT 안의 RESOURCE / KNOWLEDGE / TASK 가 LEGEND 한 줄 → 사용자가
 *        amber sphere 가 자원/제품/지식/행위 중 무엇인지 알 수 없다.
 *   V1++. LEGEND 가 카테고리만, 카운트 없음 → 현재 그래프의 분포를 사용자가
 *         즉시 파악할 수 없다.
 *   V2.  LEGEND 안내와 ForceGraph3D 의 노드 표시가 따로 살아 있음 →
 *        "WHERE = 빨간 구 + 핀셋" 인데 실제는 "회색 원형뿔" — UX 신뢰 깨짐.
 *
 * Fix 원칙:
 *   • LEGEND_SPECS 단일 source (stellarLegendShapes.ts). 이 컴포넌트 와
 *     StellarGraph 의 nodeThreeObject 가 같은 spec 함수 (specForEntityType)
 *     을 호출하므로 V2 의 안내 vs 실제 불일치가 구조적으로 발생할 수 없다.
 *   • props.nodes 로 현재 visible 노드를 받아 V1++ 카운트 계산.
 *   • unknown = 별도 row (작은 점 + 회색). person 과 시각 충돌 0.
 */
'use client';

import { useMemo, useState } from 'react';
import { LEGEND_SPECS, type LegendSpec } from '@/lib/stellarLegendShapes';
import { SHAPE_LABEL } from '@/lib/stellarShapes';
import type { StellarNode } from '@/lib/syntheticGraph';

const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';
const ACCENT = '#3fe0c6';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';

export interface StellarLegendProps {
  /** ★ L1 — top offset (px) so the host can position relative to existing
   *  surfaces (right-side search/toggle column lives at top:16). Default 110
   *  parks LEGEND below the CLAIM toggle without overlapping. */
  topOffset?: number;
  /** ★ L1 — default visible. The toggle persists in localStorage so the
   *  PO's preference survives reload. */
  defaultVisible?: boolean;
  /** ★ V1++ (PO 2026-06-29) — current visible nodes for the per-row count.
   *  Optional: when omitted the legend still renders categories without
   *  counts, so unit tests / Storybook can mount the component standalone.
   *  Counts use node.entity_type ?? null and fall through to the 'unknown'
   *  row when no spec matches — that match mirrors the renderer's dispatch
   *  via specForEntityType so the count is exactly what the user sees on
   *  the canvas. */
  nodes?: ReadonlyArray<StellarNode>;
}

const LS_KEY = 'lucid.stellar.legend.visible';

function readVisible(defaultVisible: boolean): boolean {
  if (typeof window === 'undefined') return defaultVisible;
  try {
    const v = window.localStorage.getItem(LS_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* fail-soft */
  }
  return defaultVisible;
}

function persistVisible(visible: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, visible ? '1' : '0');
  } catch {
    /* fail-soft */
  }
}

/** ★ V1++ helper — bucket each node into the legend spec it belongs to.
 *  Mirrors specForEntityType but resolves to the spec INDEX so the caller
 *  can build a count array in one pass. CLAIM and unknown are special
 *  buckets:
 *    - claim:  node.kind === 'claim' OR node.fact_type === 'claim'
 *    - unknown: no entity_type, OR entity_type that no other spec claims.
 *  Exported for unit tests. */
export function indexForNode(
  specs: ReadonlyArray<LegendSpec>,
  node: StellarNode,
): number {
  const claimIdx = specs.findIndex((s) => s.bucket === 'CLAIM');
  const unknownIdx = specs.findIndex((s) => s.bucket === 'unknown');
  if (node.kind === 'claim' || node.fact_type === 'claim') {
    return claimIdx >= 0 ? claimIdx : unknownIdx;
  }
  const t = (node.entity_type ?? '').toLowerCase();
  if (!t) return unknownIdx;
  for (let i = 0; i < specs.length; i += 1) {
    const s = specs[i];
    if (!s) continue;
    if (s.bucket === 'unknown' || s.bucket === 'CLAIM') continue;
    if (s.entity_types.includes(t)) return i;
  }
  return unknownIdx;
}

/** ★ V1++ — per-spec count across the given nodes. */
export function computeLegendCounts(
  specs: ReadonlyArray<LegendSpec>,
  nodes: ReadonlyArray<StellarNode>,
): number[] {
  const counts = new Array<number>(specs.length).fill(0);
  for (const node of nodes) {
    const i = indexForNode(specs, node);
    if (i >= 0 && i < counts.length) {
      counts[i] = (counts[i] ?? 0) + 1;
    }
  }
  return counts;
}

/** ★ V1 — small inline SVG dot for the unknown swatch. The text-character
 *  swatch (SHAPE_LABEL['dot'] = '•') reads identical to person at 14px on
 *  many fonts; an explicit 6px filled circle inside an 18px frame creates a
 *  clearly different visual silhouette (★ V1 핵심: unknown 과 사람 이
 *  시각적으로 즉시 구분돼야 한다). */
function UnknownSwatch({ color }: { color: string }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 18 18"
      width={18}
      height={18}
      aria-hidden="true"
      data-shape="dot"
    >
      <circle cx={9} cy={9} r={3} fill={color} />
    </svg>
  );
}

export function StellarLegend(props: StellarLegendProps = {}): React.ReactElement {
  const defaultVisible = props.defaultVisible ?? true;
  const nodes = props.nodes ?? [];
  // ★ default = visible (PO 명시). User can collapse and the choice persists.
  const [visible, setVisible] = useState<boolean>(() => readVisible(defaultVisible));

  // ★ V1++ — per-row count, memo so the math only re-runs on node list change.
  const counts = useMemo(() => computeLegendCounts(LEGEND_SPECS, nodes), [nodes]);

  function onToggle(): void {
    setVisible((v) => {
      const next = !v;
      persistVisible(next);
      return next;
    });
  }

  return (
    <aside
      data-testid="stellar-legend"
      data-visible={visible ? '1' : '0'}
      style={{
        position: 'absolute',
        top: props.topOffset ?? 110,
        right: 18,
        zIndex: 10,
        width: visible ? 248 : 130,
        padding: visible ? '12px 14px' : '6px 10px',
        borderRadius: 12,
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        color: TEXT_BODY,
        fontFamily: 'Pretendard, sans-serif',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 8px 22px rgba(0,0,0,0.45)',
        transition: 'width 160ms ease, padding 160ms ease',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: visible ? 10 : 0,
        }}
      >
        <span
          data-testid="stellar-legend-title"
          style={{
            color: ACCENT,
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          LEGEND · 범례
        </span>
        <button
          type="button"
          data-testid="stellar-legend-toggle"
          aria-pressed={visible}
          aria-label={visible ? '범례 숨기기' : '범례 보기'}
          onClick={onToggle}
          style={{
            background: 'transparent',
            border: `1px solid ${PANEL_BORDER}`,
            borderRadius: 4,
            color: TEXT_DIM,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            width: 22,
            height: 22,
            lineHeight: '20px',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {visible ? '−' : '+'}
        </button>
      </header>
      {visible ? (
        <ul
          data-testid="stellar-legend-list"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {LEGEND_SPECS.map((spec, i) => {
            const count = counts[i] ?? 0;
            return (
              <li
                key={spec.key}
                data-testid={`stellar-legend-item-${spec.key}`}
                data-bucket={spec.bucket}
                data-sub-bucket={spec.subBucket ?? ''}
                data-shape={spec.shape}
                data-color={spec.color}
                data-count={count}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 11,
                  color: TEXT_BODY,
                }}
              >
                <span
                  data-testid={`stellar-legend-swatch-${spec.key}`}
                  data-shape={spec.shape}
                  data-color={spec.color}
                  aria-hidden="true"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    color: spec.color,
                    fontSize: 14,
                    lineHeight: 1,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {spec.shape === 'dot' ? (
                    <UnknownSwatch color={spec.color} />
                  ) : (
                    SHAPE_LABEL[spec.shape]
                  )}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {spec.label}
                </span>
                {/* ★ V1++ — per-category count. Always rendered (even when 0)
                 *  so the dashboard "지금 분포 = 0" 도 명시적으로 보인다.
                 *  data-testid 는 카운트 만 추출 가능하게 분리. */}
                <span
                  data-testid={`stellar-legend-count-${spec.key}`}
                  style={{
                    color: TEXT_DIM,
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                    marginLeft: 4,
                    flexShrink: 0,
                  }}
                >
                  ({count})
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </aside>
  );
}

export default StellarLegend;
