/**
 * ★ L1 (STELLAR legend/shape/hover, PO 2026-06-29) — STELLAR LEGEND.
 *
 * 위반 클래스: 노드 색·형태를 의미 안내 없이 도입 → 사용자가 추측만 가능.
 *
 * Fix 원칙:
 *   • LEGEND default = visible (★ 첫 진입 시 보임).
 *   • 사용자가 끌 수 있어야 (★ 화면 점유 가드).
 *   • 색 swatch + 형태 swatch 둘 다 안내 — L2 의 형태 분리 (sphere / cube /
 *     diamond / roundedSquare / pin) 가 같이 노출돼야 의미 안내가 완성된다.
 *   • 특정 케이스 하드코딩 0 — ENTITY_COLORS / ENTITY_SHAPES 로부터 어휘를
 *     끌어오므로 새 entity_type 가 추가돼도 자동으로 반영된다.
 */
'use client';

import { useState } from 'react';
import { ENTITY_COLORS, CLAIM_NODE_COLOR, STELLAR_ACCENT } from '@/lib/stellarColors';
import { SHAPE_LABEL, shapeForEntityType, CLAIM_SHAPE } from '@/lib/stellarShapes';

const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';
const ACCENT = '#3fe0c6';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';

interface LegendItem {
  /** Render key. */
  key: string;
  /** Color swatch (entity / claim / unknown color). */
  color: string;
  /** Form swatch label (★ L2 — '●' / '■' / '◆' / '▢' / '📍' / '•'). */
  shapeChar: string;
  /** Human-readable label (KR). */
  label: string;
}

/** ★ L1 — derive the legend from the shared color / shape vocabularies so
 *  the legend can never drift away from what the renderer actually paints.
 *  Order: WHO 3종 (person / organization / group) → WHAT → EVENT → WHERE
 *  → CLAIM → unknown. */
function buildLegendItems(): LegendItem[] {
  return [
    {
      key: 'person',
      color: ENTITY_COLORS.person,
      shapeChar: SHAPE_LABEL[shapeForEntityType('person')],
      label: 'WHO · 사람',
    },
    {
      key: 'organization',
      color: ENTITY_COLORS.organization,
      shapeChar: SHAPE_LABEL[shapeForEntityType('organization')],
      label: 'WHO · 조직',
    },
    {
      key: 'group',
      color: ENTITY_COLORS.group,
      shapeChar: SHAPE_LABEL[shapeForEntityType('group')],
      label: 'WHO · 그룹',
    },
    {
      key: 'what',
      color: ENTITY_COLORS.product,
      shapeChar: SHAPE_LABEL[shapeForEntityType('product')],
      label: 'WHAT · 개념/제품',
    },
    {
      key: 'event',
      color: ENTITY_COLORS.event,
      shapeChar: SHAPE_LABEL[shapeForEntityType('event')],
      label: 'EVENT · 이벤트',
    },
    {
      key: 'place',
      color: ENTITY_COLORS.place,
      shapeChar: SHAPE_LABEL[shapeForEntityType('place')],
      label: 'WHERE · 장소',
    },
    {
      key: 'claim',
      color: CLAIM_NODE_COLOR,
      shapeChar: SHAPE_LABEL[CLAIM_SHAPE],
      label: '발언 · claim',
    },
    {
      key: 'unknown',
      color: STELLAR_ACCENT,
      shapeChar: SHAPE_LABEL.sphere,
      label: '기타 · unknown',
    },
  ];
}

export const LEGEND_ITEMS: ReadonlyArray<LegendItem> = buildLegendItems();

export interface StellarLegendProps {
  /** ★ L1 — top offset (px) so the host can position relative to existing
   *  surfaces (right-side search/toggle column lives at top:16). Default 110
   *  parks LEGEND below the CLAIM toggle without overlapping. */
  topOffset?: number;
  /** ★ L1 — default visible. The toggle persists in localStorage so the
   *  PO's preference survives reload. */
  defaultVisible?: boolean;
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

export function StellarLegend(props: StellarLegendProps = {}): React.ReactElement {
  const defaultVisible = props.defaultVisible ?? true;
  // ★ default = visible (PO 명시). User can collapse and the choice persists.
  const [visible, setVisible] = useState<boolean>(() => readVisible(defaultVisible));

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
        width: visible ? 220 : 130,
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
          {LEGEND_ITEMS.map((item) => (
            <li
              key={item.key}
              data-testid={`stellar-legend-item-${item.key}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: TEXT_BODY,
              }}
            >
              <span
                data-testid={`stellar-legend-swatch-${item.key}`}
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  color: item.color,
                  fontSize: 14,
                  lineHeight: 1,
                  fontWeight: 700,
                }}
              >
                {item.shapeChar}
              </span>
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

export default StellarLegend;
