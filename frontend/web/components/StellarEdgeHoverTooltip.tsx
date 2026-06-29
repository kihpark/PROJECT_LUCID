/**
 * ★ L4 (STELLAR legend/shape/hover, PO 2026-06-29) — edge hover tooltip.
 *
 * 위반 클래스: edge hover 시 SPO 전체 또는 fact list 표시 → noise.
 *
 * Fix 원칙:
 *   • hover = predicate (verb) label only. 예: "체결" / "위치" / "관련".
 *   • 작은 floating tooltip, 다른 UI 가리지 않게.
 *   • pointerEvents:none — hover state 를 방해하지 않는다.
 *   • click 은 다른 동작 (EdgeFactsList 가 열린다 — W1 보존).
 */
'use client';

import { predicateLabel } from '@/lib/predicateLabels';

const ACCENT = '#5EEAD4';
const PANEL_BG = 'rgba(8,12,14,0.9)';
const PANEL_BORDER = '#1c272b';

export interface StellarEdgeHoverTooltipProps {
  /** Predicate string from the StellarLink (raw English snake_case OR a
   *  natural verb already in Korean — both are passed through the KR
   *  predicateLabel helper which falls back to the raw value). */
  predicate: string | null;
  /** Optional list of predicates when multiple facts join the same pair —
   *  ★ predicate-only hint per L4. Falls back to the primary `predicate`
   *  when omitted. */
  predicates?: string[] | null;
  /** Cursor coords (clientX / clientY). */
  position: { x: number; y: number };
}

const OFFSET = 16;
const MAX_W = 240;
const MAX_H = 60;

/** ★ L4 — viewport-safe placement. Exported so unit tests can pin the
 *  policy without rendering. */
export function computeEdgeTooltipPosition(
  cursor: { x: number; y: number },
  viewport: { w: number; h: number },
  cardSize: { w: number; h: number } = { w: MAX_W, h: MAX_H },
): { left: number; top: number } {
  const left = Math.max(
    0,
    Math.min(cursor.x + OFFSET, viewport.w - cardSize.w),
  );
  const top = Math.max(
    0,
    Math.min(cursor.y + OFFSET, viewport.h - cardSize.h),
  );
  return { left, top };
}

export function StellarEdgeHoverTooltip(
  props: StellarEdgeHoverTooltipProps,
): React.ReactElement | null {
  const { predicate, predicates, position } = props;
  // ★ L4 — predicate label only (KR gloss when known, raw otherwise).
  const items = (predicates ?? []).filter((p): p is string => !!p && p.trim().length > 0);
  let labelText = '';
  if (items.length > 1) {
    // Multiple predicates joined by " · " — still predicate-only per L4.
    labelText = items.map((p) => predicateLabel(p)).join(' · ');
  } else if (predicate && predicate.trim().length > 0) {
    labelText = predicateLabel(predicate);
  } else if (items.length === 1) {
    labelText = predicateLabel(items[0]!);
  }

  if (!labelText) return null;

  const viewport =
    typeof window === 'undefined'
      ? { w: 1920, h: 1080 }
      : { w: window.innerWidth, h: window.innerHeight };
  const { left, top } = computeEdgeTooltipPosition(
    { x: position.x, y: position.y },
    viewport,
  );

  return (
    <div
      data-testid="stellar-edge-hover-tooltip"
      data-predicate={predicate ?? ''}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 30,
        // ★ L4 — pointerEvents none so the hover state never breaks.
        pointerEvents: 'none',
        padding: '6px 10px',
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderLeft: `3px solid ${ACCENT}`,
        borderRadius: 6,
        color: ACCENT,
        fontFamily: 'Pretendard, sans-serif',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.02em',
        boxShadow: '0 6px 14px rgba(0,0,0,0.4)',
        maxWidth: MAX_W,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {labelText}
    </div>
  );
}

export default StellarEdgeHoverTooltip;
