/**
 * M3-2d StellarEntityCard — 노드 클릭 → entity 카드 (우패널).
 * PO 의뢰서 verbatim + fix/stellar-cards-entity-node-compat (2026-06-29).
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
 *
 * ★ fix/stellar-cards-entity-node-compat (PO 2026-06-29):
 *   STELLAR v2 의 entity-node + link 모델 지원.
 *   - links prop 이 주어지고 entity.kind === 'entity' 면 link 기반 카운트.
 *   - 이름은 pickEntityName(entity) 로 노출 ('(주체 없음)' 제거).
 *   - kind === 'entity' 인 경우 LEDGER 딥링크는 entity.id 사용.
 *
 * ★ V3a (STELLAR 발언 full context 위반 클래스, 2026-06-29):
 *   focus 노드가 claim (kind === 'claim') 일 때는 ENTITY 레이아웃이
 *   전혀 맞지 않는다. 사용자는 발언의 FULL 내용 (truncate 금지) + 화자 +
 *   양태 + 관련 entity + RECALL/LEDGER 딥링크를 한 화면에서 봐야 한다.
 *   분기는 함수 진입부에서 즉시 처리하고, 기존 entity 분기는 그대로.
 */
'use client';

import Link from 'next/link';
import type { StellarLink, StellarNode } from '@/lib/syntheticGraph';
import {
  pickEntityName,
  classifyClaimModality,
  MODALITY_LABEL,
} from './StellarHoverCard';

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
 *  A measurement fact "touches" when entity is the subject.
 *
 *  ★ Legacy / synthetic compat: this helper still expects "1 fact = 1 node".
 *  v2 entity-node graphs should use countFactsFromLinks instead. */
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

/** fix/stellar-cards-entity-node-compat — v2 link-driven fact counts.
 *  Returns the same shape as countFactsByType so render code is symmetric.
 *
 *  action       = links where (source===id || target===id) && kind==='action',
 *                 summed by fact_count (default 1 per link).
 *  claim        = links where (source===id && kind==='speaker') count +
 *                 (target===id && kind==='claim_related') count,
 *                 summed by fact_count.
 *  measurement  = entity.measurements?.length ?? 0.
 *
 *  Pure for testability. */
export function countFactsFromLinks(
  entity: StellarNode,
  links: StellarLink[],
): { action: number; claim: number; measurement: number } {
  const id = entity.id;
  let action = 0;
  let claim = 0;
  for (const l of links) {
    const src = String(l.source);
    const tgt = String(l.target);
    const count = typeof l.fact_count === 'number' ? l.fact_count : 1;
    if (l.kind === 'action' && (src === id || tgt === id)) {
      action += count;
    } else if (l.kind === 'speaker' && src === id) {
      claim += count;
    } else if (l.kind === 'claim_related' && tgt === id) {
      claim += count;
    }
  }
  const measurement = Array.isArray(entity.measurements)
    ? entity.measurements.length
    : 0;
  return { action, claim, measurement };
}

export interface StellarEntityCardProps {
  /** The clicked node — taken as the entity anchor. */
  entity: StellarNode;
  /** Full fact set so we can count fact_type buckets (legacy / synthetic path). */
  allFacts: StellarNode[];
  /** fix/stellar-cards-entity-node-compat — v2 link list. When provided AND
   *  entity.kind === 'entity', counts are computed from links + measurements. */
  links?: StellarLink[];
  /** Close handler — clears the focus on the parent. */
  onClose: () => void;
}

export function StellarEntityCard({
  entity,
  allFacts,
  links,
  onClose,
}: StellarEntityCardProps) {
  // V3a — claim 노드 분기.
  if (entity.kind === 'claim') {
    const speaker = entity.speaker_label?.trim() || pickEntityName(entity);
    const speechAct = entity.speech_act?.trim() || '말함';
    const modality = classifyClaimModality(entity.speech_act);
    const verbLine = modality ? MODALITY_LABEL[modality] : speechAct;
    const fullContent =
      (entity.content_claim && entity.content_claim.trim()) ||
      (entity.object && entity.object.trim()) ||
      (entity.label && entity.label.trim()) ||
      '';
    const relatedLabels =
      entity.related_entity_labels && entity.related_entity_labels.length > 0
        ? entity.related_entity_labels
        : null;
    const recallQuery = fullContent || speaker;
    const recallHref = `/recall?q=${encodeURIComponent(recallQuery)}`;
    const ledgerHref = `/ledger?fact=${encodeURIComponent(entity.id)}`;
    return (
      <aside
        data-testid="stellar-entity-card-claim"
        role="dialog"
        aria-label="claim detail"
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
            STELLAR · 발언
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
        <div data-testid="stellar-entity-card-claim-speaker"
          style={{ fontSize: 16, fontWeight: 700, color: WHO_COLOR, lineHeight: 1.4 }}>
          {speaker}
        </div>
        <div data-testid="stellar-entity-card-claim-speech-act"
          data-modality={modality ?? ''}
          style={{ marginTop: 4, fontSize: 12, color: ACCENT, fontWeight: 600, letterSpacing: '0.02em' }}>
          {verbLine}
        </div>
        <div data-testid="stellar-entity-card-claim-content"
          data-content-length={fullContent.length}
          style={{ marginTop: 14, borderTop: `1px solid ${PANEL_BORDER}`, paddingTop: 14, fontSize: 13, color: TEXT_BODY, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: 'italic' }}>
          {fullContent ? `“${fullContent}”` : ''}
        </div>
        {relatedLabels ? (
          <div data-testid="stellar-entity-card-claim-related"
            style={{ marginTop: 12, fontSize: 11, color: TEXT_DIM, lineHeight: 1.5 }}>
            관련: {relatedLabels.join(', ')}
          </div>
        ) : null}
        {/* ★ W5 (STELLAR 6-class fix, 2026-06-29) — self-count semantics.
         *  CLAIM 노드 클릭 시 카드 자체가 한 발언의 isolated detail view 이므로
         *  "이 발언 1건" 의 self-count 를 보여야 한다. 다른 entity 카드의
         *  fact_counts surface 와 다르다. */}
        <div
          data-testid="stellar-entity-card-claim-self-count"
          style={{
            marginTop: 12,
            fontSize: 11,
            color: TEXT_DIM,
            letterSpacing: '0.02em',
          }}
        >
          이 발언 1건
        </div>
        <div data-testid="stellar-entity-card-claim-deeplinks"
          style={{ marginTop: 18, borderTop: `1px solid ${PANEL_BORDER}`, paddingTop: 14, display: 'flex', gap: 8 }}>
          <Link href={recallHref} data-testid="stellar-entity-card-claim-recall-link"
            style={{ flex: 1, background: 'rgba(94,234,212,0.08)', border: `1px solid ${ACCENT}`, color: ACCENT, borderRadius: 8, padding: '8px 10px', fontSize: 12, fontWeight: 600, textAlign: 'center', textDecoration: 'none' }}>
            RECALL 에서 보기
          </Link>
          <Link href={ledgerHref} data-testid="stellar-entity-card-claim-ledger-link"
            style={{ flex: 1, background: 'rgba(94,234,212,0.08)', border: `1px solid ${ACCENT}`, color: ACCENT, borderRadius: 8, padding: '8px 10px', fontSize: 12, fontWeight: 600, textAlign: 'center', textDecoration: 'none' }}>
            LEDGER 에서 보기
          </Link>
        </div>
      </aside>
    );
  }

  // fix/stellar-cards-entity-node-compat — v2 (entity-node + links) takes
  // priority. Legacy / synthetic callers omit `links` → fall back to the
  // existing 1-fact-per-node count path so old tests stay green.
  //
  // ★ fix/entitycard-fact-count-and-dot-suggestion — entity.fact_counts 가
  //   adapter 에서 직접 누적되어 있으면 그것이 진실. link/edge 와 무관하게
  //   ACTION (literal object 포함) / CLAIM / MEASUREMENT 가 전부 셈된다.
  //   없으면 기존 link-derived (v2) → countFactsByType (legacy) fallback.
  const counts = entity.fact_counts
    ? {
        action: entity.fact_counts.action,
        claim: entity.fact_counts.claim,
        measurement: entity.fact_counts.measurement,
      }
    : links && entity.kind === 'entity'
      ? countFactsFromLinks(entity, links)
      : countFactsByType(entity, allFacts);
  const entityName = pickEntityName(entity);
  const entityType =
    entity.entity_type?.trim() ||
    entity.subject_entity_type?.trim() ||
    null;
  // LEDGER / RECALL 딥링크.
  // v2 entity 노드는 node.id 가 곧 entity uid → 직접 사용.
  // 레거시는 subject_uid 가 fact 안의 entity 참조 → 그 값을 사용.
  const ledgerEntityKey =
    entity.kind === 'entity' ? entity.id : entity.subject_uid;
  const ledgerHref = ledgerEntityKey
    ? `/ledger?entity=${encodeURIComponent(ledgerEntityKey)}`
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

      {/* ★ W2 (STELLAR 6-class fix, 2026-06-29) — measurement values.
       *  entity 카드는 "수치 fact N건" 카운트만 보여줬을 뿐 실제
       *  metric/value/unit/as_of 가 어디에서도 surface 되지 않았다.
       *  이 섹션이 entity.measurements 배열을 listing → 사용자가 한
       *  entity 의 numeric vital 을 STELLAR 안에서 바로 읽을 수 있다. */}
      {entity.measurements && entity.measurements.length > 0 ? (
        <section
          data-testid="stellar-entity-card-measurements"
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
              textTransform: 'uppercase',
            }}
          >
            수치 ({entity.measurements.length}건)
          </div>
          {entity.measurements.map((m, i) => (
            <div
              key={`${m.fact_uid}-${i}`}
              data-testid="stellar-entity-card-measurement-row"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 12,
                marginBottom: 4,
              }}
            >
              <span style={{ color: TEXT_BODY }}>{m.metric ?? '(metric)'}</span>
              <span style={{ color: ACCENT, fontWeight: 600 }}>
                {m.value ?? ''} {m.unit ?? ''}
                {m.as_of ? (
                  <span style={{ color: TEXT_DIM, marginLeft: 6 }}>
                    {' '}
                    · {m.as_of}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </section>
      ) : null}

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
