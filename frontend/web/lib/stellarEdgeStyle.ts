/**
 * M3-2b STELLAR 엣지 스타일 (PO 2026-06-28 정정 spec).
 *
 * ★ 점선 폐기: ACTION / CLAIM-related-to 모두 **실선**.
 *   구분 = color hue 만 (행위 vs 발언 성격).
 *
 * ★ link_status (verified/claimed) → 시각에 X. 데이터 메타데이터 only.
 *
 * 두께만 fact 수로 조정한다 (log scale).
 */

import type { CSSProperties } from 'react';

/** ACTION 엣지 색 — teal. 행위 자체가 검증된 fact. */
export const ACTION_EDGE_COLOR = '#5EEAD4';

/** CLAIM related-to 엣지 색 — amber. 발언 성격으로 구분. ★ 실선. */
export const CLAIM_EDGE_COLOR = '#F5C36B';

/** Edge type discriminator. */
export type StellarEdgeKind = 'action' | 'claim_related';

/** Style descriptor consumed by the renderer. ★ 항상 solid. */
export interface StellarEdgeStyle {
  /** ★ 항상 'solid'. dashed 는 절대 등장하지 않는다. */
  type: 'solid';
  color: string;
  width: number;
  /** ★ 항상 1. PO 정정 가드. */
  opacity: 1;
}

/** Compute edge thickness from fact count (log scale, clamped).
 *  1 fact → 1.0, 10 facts → ~2.0, 100 facts → ~3.0. */
export function edgeWidth(factCount: number): number {
  const n = Math.max(1, Math.floor(factCount));
  // 1 + log10(n): 1→1.0, 10→2.0, 100→3.0. Clamp to [0.8, 5.0] so a single
  // fact still reads as a real line and the brightest constellation edge
  // doesn't bloat past the node radius.
  const raw = 1 + Math.log10(n);
  return Math.max(0.8, Math.min(5.0, raw));
}

/** Build the visual style for an edge of the given kind and fact count.
 *
 *  ★ PO 정정 contract:
 *    - `type` is ALWAYS 'solid'
 *    - `opacity` is ALWAYS 1
 *    - color depends ONLY on `kind` (행위 vs 발언), NEVER on link_status
 *    - width depends ONLY on fact count
 */
export function edgeStyle(
  kind: StellarEdgeKind,
  factCount: number = 1,
): StellarEdgeStyle {
  const color = kind === 'action' ? ACTION_EDGE_COLOR : CLAIM_EDGE_COLOR;
  return {
    type: 'solid',
    color,
    width: edgeWidth(factCount),
    opacity: 1,
  };
}

/** Compute node radius from graph degree (log scale, clamped to [4, 24]).
 *  Pure helper exported so tests can pin the policy without rendering. */
export function nodeRadius(degree: number): number {
  const MIN = 4;
  const MAX = 24;
  const d = Math.max(1, degree);
  // log10(d) / log10(50) maps 1→0, 50→1; scaled across [MIN, MAX].
  const r = MIN + (Math.log10(d) / Math.log10(50)) * (MAX - MIN);
  return Math.max(MIN, Math.min(MAX, r));
}

/** ★ PO 정정 명시 가드: link_status 는 시각에 영향을 주면 안 된다.
 *
 *  이 함수는 'verified' / 'claimed' 어떤 값이 들어와도 같은 style 을
 *  반환하도록 설계되었다. 테스트에서 양쪽 호출 결과의 deep equality 로
 *  unbind 를 검증한다.
 *
 *  주의: 호출자가 실수로 link_status 를 색/opacity 에 묶지 못하도록
 *  이 함수는 link_status 인자를 받되 그 값을 무시한다 (★ 데이터 메타
 *  데이터로만 흘려보내는 용도). */
export function edgeStyleIgnoringLinkStatus(
  kind: StellarEdgeKind,
  factCount: number = 1,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _linkStatus?: 'verified' | 'claimed' | string | null,
): StellarEdgeStyle {
  // ★ _linkStatus 는 절대 사용되지 않는다. PO 정정 가드.
  return edgeStyle(kind, factCount);
}

/** Convenience: convert a StellarEdgeStyle into the React CSS shape used
 *  by SVG line elements. ★ never emits strokeDasharray. */
export function edgeStyleToCss(style: StellarEdgeStyle): CSSProperties {
  return {
    stroke: style.color,
    strokeWidth: style.width,
    strokeOpacity: style.opacity,
    // ★ 명시적으로 'none' 을 지정해서 dashed 가 절대 흘러나오지 않도록.
    strokeDasharray: 'none',
  };
}
