/**
 * M3-2d StellarEntityCard — 노드 클릭 → entity 카드 (우패널).
 * PO 의뢰서 verbatim.
 *
 * 노드 = 한 entity. 이 카드는 그 entity 에 연결된 모든 fact 를
 * fact_type 별로 분류하고, LEDGER / RECALL 로의 딥링크를 제공한다.
 *
 * 형식:
 *   {entity_name}                          ← WHO 색
 *   [entity_type]                          ← 작은 회색 라벨
 *
 *   행동 fact   N건                          ← fact_type 별 카운트
 *   발언 fact   N건
 *   수치 fact   N건
 *
 *   [LEDGER 에서 보기]  [RECALL 에서 보기]    ← 딥링크
 *
 *   ─────────
 *   다음 단계 (사용자 수동 통합/분리)         ← M3-2 이후 placeholder
 *
 * ★ PO 정정: link_status 시각 unbind — 어떤 시각 강약도 link_status 에
 *   묶이지 않는다. 카운트는 fact_type 기준으로만.
 */
'use client';

import Link from 'next/link';
import type { StellarNode } from '@/lib/syntheticGraph';

const ACCENT = '#5EEAD4';
const WHO_COLOR = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';
const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';

/** Count facts of each fact_type that touch this entity.
 *  An action fact "touches" the entity when entity is the subject.
 *  A claim fact "touches" when entity is the speaker (= subject).
 *  A measurement fact "touches" when entity is the subject. */
export function countFactsByType(
  entity: StellarNode,
  allFacts: StellarNode[],
): { action: number; claim: number; measurement: number } {
  const entityKey = entity.subject_uid ?? entity.subject;
  let action = 0;
  let claim = 0;
  let measurement = 0;
  for (const f of allFacts) {
    const fKey = f.subject_uid ?? f.subject;
    if (fKey !== entityKey) continue;
    const ft = f.fact_type ?? 'action';
    if (ft === 'action') action += 1;
    else if (ft === 'claim') claim += 1;
    else if (ft === 'measurement') measurement += 1;
  }
  return { action, claim, measurement };
}

export interface StellarEntityCardProps {
  /** The clicked node — taken as the entity anchor. */
  entity: StellarNode;
  /** Full fact set so we can count fact_type buckets. */
  allFacts: StellarNode[];
  /** Close handler — clears the focus on the parent. */
  onClose: () => void;
}

export function StellarEntityCard({
  entity,
  allFacts,
  onClose,
}: StellarEntityCardProps) {
  const counts = countFactsByType(entity, allFacts);
  const entityName = entity.subject || '(주체 없음)';
  const entityType = entity.subject_entity_type ?? null;
  // LEDGER / RECALL 딥링크 — 의뢰서 verbatim.
  const ledgerHref = entity.subject_uid
    ? `/ledger?entity=${encodeURIComponent(entity.subject_uid)}`
    : '/ledger';
  const recallHref = `/recall?q=${encodeURIComponent(entityName)}`;

  return (
    <aside
      data-testid="stellar-entity-card"
      role="dialog"
      aria-label="entity detail"
      style={{
        position: 'absolute',
        top: 16,
        right: 18,
        zIndex: 20,
        width: 360,
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
          style={{
            color: ACCENT,
            fontSize: 11,
            letterSpacing: '0.08em',
            fontWeight: 600,
          }}
        >
          STELLAR · ENTITY
        </span>
        <button
          type="button"
          data-testid="stellar-entity-card-close"
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

      <div
        data-testid="stellar-entity-card-name"
        style={{ fontSize: 16, fontWeight: 700, color: WHO_COLOR, lineHeight: 1.4 }}
      >
        {entityName}
      </div>
      {entityType ? (
        <div
          data-testid="stellar-entity-card-type"
          style={{ marginTop: 4, fontSize: 11, color: TEXT_DIM }}
        >
          {entityType}
        </div>
      ) : null}

      {/* fact_type 별 카운트 — 의뢰서 verbatim. */}
      <div
        data-testid="stellar-entity-card-counts"
        style={{
          marginTop: 16,
          borderTop: `1px solid ${PANEL_BORDER}`,
          paddingTop: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: TEXT_DIM,
            letterSpacing: '0.08em',
            marginBottom: 4,
            textTransform: 'uppercase',
          }}
        >
          연결된 fact
        </div>
        <div
          data-testid="stellar-entity-card-count-action"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
        >
          <span style={{ color: TEXT_BODY }}>행동 fact</span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{counts.action}건</span>
        </div>
        <div
          data-testid="stellar-entity-card-count-claim"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
        >
          <span style={{ color: TEXT_BODY }}>발언 fact</span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{counts.claim}건</span>
        </div>
        <div
          data-testid="stellar-entity-card-count-measurement"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
        >
          <span style={{ color: TEXT_BODY }}>수치 fact</span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{counts.measurement}건</span>
        </div>
      </div>

      {/* LEDGER / RECALL 딥링크 — 의뢰서 verbatim. */}
      <div
        data-testid="stellar-entity-card-deeplinks"
        style={{
          marginTop: 18,
          borderTop: `1px solid ${PANEL_BORDER}`,
          paddingTop: 14,
          display: 'flex',
          gap: 8,
        }}
      >
        <Link
          href={ledgerHref}
          data-testid="stellar-entity-card-ledger-link"
          style={{
            flex: 1,
            background: 'rgba(94,234,212,0.08)',
            border: `1px solid ${ACCENT}`,
            color: ACCENT,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            fontWeight: 600,
            textAlign: 'center',
            textDecoration: 'none',
          }}
        >
          LEDGER 에서 보기
        </Link>
        <Link
          href={recallHref}
          data-testid="stellar-entity-card-recall-link"
          style={{
            flex: 1,
            background: 'rgba(94,234,212,0.08)',
            border: `1px solid ${ACCENT}`,
            color: ACCENT,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            fontWeight: 600,
            textAlign: 'center',
            textDecoration: 'none',
          }}
        >
          RECALL 에서 보기
        </Link>
      </div>

      {/* ★ M3-2 이후 사용자 수동 통합/분리 진입점 placeholder. */}
      <div
        data-testid="stellar-entity-card-merge-placeholder"
        style={{
          marginTop: 18,
          borderTop: `1px solid ${PANEL_BORDER}`,
          paddingTop: 14,
          fontSize: 11,
          color: TEXT_DIM,
          lineHeight: 1.5,
        }}
      >
        다음 단계 — 사용자 수동 통합/분리 (M3-2 이후 별도 트랙).
      </div>
    </aside>
  );
}

export default StellarEntityCard;
