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

// ★ REQ-013 (PO 2026-07-02) — 팝업 내 "기록에서 보기" / "검색에서 보기"
//   버튼 폐기 (entity + claim 분기 모두). next/link import 제거 — 남은 링크 없음.
import { useState } from 'react';
import type { StellarLink, StellarNode } from '@/lib/syntheticGraph';
import {
  pickEntityName,
  classifyClaimModality,
  MODALITY_LABEL,
} from './StellarHoverCard';
import { entityTypeLabelKo } from '@/lib/displayNames';
import { EntityTypeDropdown } from './EntityTypeDropdown';
import { MergeCandidatesModal } from './MergeCandidatesModal';
import { EntityNameEdit } from './EntityNameEdit';
import { EntityDeleteButton } from './EntityDeleteButton';

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
  /** REQ-012-v1 — knowledge space id for entity edit / merge endpoints.
   *  Omitted = edit UX 비활성 (M3-2d behavior preserved for synthetic mode). */
  spaceId?: string | null;
  /** REQ-012-v1 — entity 변경 후 부모가 그래프를 refetch 하도록. */
  onEntityChanged?: () => void;
  /** Close handler — clears the focus on the parent. */
  onClose: () => void;
  /** ★ REQ-013 (PO 2026-07-02) — 팝업을 선택된 노드의 오른쪽에 띄우기.
   *  StellarGraph 가 fgRef.graph2ScreenCoords(node.x,y,z) 로 계산해
   *  StellarView 를 통해 넘겨준다. null 이면 옛 top-right 위치로 fallback. */
  position?: { x: number; y: number } | null;
}

/** ★ REQ-013 — 뷰포트 내에서 카드가 잘리지 않도록 clamp.
 *  screen coords 는 canvas 상단-좌 origin. 카드 폭 360 / 대략 높이 480. */
function computeCardStyle(
  position: { x: number; y: number } | null | undefined,
): React.CSSProperties {
  const CARD_WIDTH = 360;
  const CARD_HEIGHT_ESTIMATE = 520;
  const OFFSET_X = 40;
  const OFFSET_Y = -100;
  const MARGIN = 12;
  if (!position) {
    // fallback: 옛 top-right 위치.
    return { top: 16, right: 18, marginTop: 56 };
  }
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
  let left = position.x + OFFSET_X;
  let top = position.y + OFFSET_Y;
  // Right edge clamp — 노드가 오른쪽에 있으면 왼쪽으로 뒤집는다.
  if (left + CARD_WIDTH + MARGIN > vw) {
    left = Math.max(MARGIN, position.x - CARD_WIDTH - OFFSET_X);
  }
  if (left < MARGIN) left = MARGIN;
  // Bottom edge clamp.
  if (top + CARD_HEIGHT_ESTIMATE + MARGIN > vh) {
    top = Math.max(MARGIN, vh - CARD_HEIGHT_ESTIMATE - MARGIN);
  }
  if (top < MARGIN) top = MARGIN;
  return { left, top };
}

export function StellarEntityCard({
  entity,
  allFacts,
  links,
  spaceId,
  onEntityChanged,
  onClose,
  position,
}: StellarEntityCardProps) {
  const posStyle = computeCardStyle(position);
  // REQ-012-v1 — merge modal toggle local state.
  // Lives here (not on parent) because the entity card is the single
  // entry point per PO 의뢰서 (StellarEntityCard / LedgerCard /
  // RecallEvidenceCard). Other entry points instantiate their own card.
  const [mergeOpen, setMergeOpen] = useState(false);
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
    // ★ REQ-013 (PO 2026-07-02) — claim 팝업에서 "기록·검색 딥링크" 폐기.
    //   recallHref / ledgerHref 계산 자체 제거 (dead code 방지).
    return (
      <aside
        data-testid="stellar-entity-card-claim"
        role="dialog"
        aria-label="claim detail"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: position ? 'fixed' : 'absolute',
          ...posStyle,
          zIndex: 20,
          width: 360,
          maxHeight: 'calc(100% - 32px)',
          overflowY: 'auto',
          background: PANEL_BG,
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 14,
          padding: 18,
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
            지식그래프 · 발언
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
        {/* ★ REQ-013 (PO 2026-07-02) — claim 팝업의 "기록·검색 딥링크" 폐기.
         *   사용자가 팝업에서 이동 필요를 못 느꼈고, 시각 잡음 감소가 우선. */}
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
  // ★ REQ-013 (PO 2026-07-02) — entity 팝업 내 "기록·검색 딥링크" 버튼 폐기.
  //   ledgerHref / recallHref 계산 제거. ledgerEntityKey 는 EntityNameEdit /
  //   EntityTypeDropdown / MergeCandidates / EntityDelete 진입 조건에 계속
  //   쓰이므로 유지한다.
  const ledgerEntityKey =
    entity.kind === 'entity' ? entity.id : entity.subject_uid;

  return (
    <aside
      data-testid="stellar-entity-card"
      role="dialog"
      aria-label="entity detail"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: position ? 'fixed' : 'absolute',
        ...posStyle,
        zIndex: 20,
        width: 360,
        maxHeight: 'calc(100% - 32px)',
        overflowY: 'auto',
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderRadius: 14,
        padding: 18,
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
          지식그래프 · 엔티티
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
          // feat/i18n-ko-display-names-separation — 표시 = 한국어 (사용자
          // 노출 영문 token 0). 내부 data-attr 은 raw token 유지 (회귀 0,
          // 테스트 / 디버그 hook 보존).
          data-entity-type={entityType}
          style={{ marginTop: 4, fontSize: 11, color: TEXT_DIM }}
        >
          {entityTypeLabelKo(entityType)}
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
          연결된 사실
        </div>
        <div
          data-testid="stellar-entity-card-count-action"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
        >
          <span style={{ color: TEXT_BODY }}>행동 사실</span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{counts.action}건</span>
        </div>
        <div
          data-testid="stellar-entity-card-count-claim"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
        >
          <span style={{ color: TEXT_BODY }}>발언 사실</span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{counts.claim}건</span>
        </div>
        <div
          data-testid="stellar-entity-card-count-measurement"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
        >
          <span style={{ color: TEXT_BODY }}>수치 사실</span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{counts.measurement}건</span>
        </div>
      </div>

      {/* ★ REQ-013 (PO 2026-07-02) — 팝업 내 "기록/검색에서 보기" 버튼 폐기.
       *   사용자는 팝업 안에서 편집·병합·삭제 중심으로 조작한다. 딥링크는
       *   시각 잡음이었고 팝업 우측 노드 위치 접근성을 방해했다. 팝업 X /
       *   Esc / outside-click 으로 닫고 상단 네비게이션으로 이동. */}

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

      {/* ★ REQ-012-v1 (PO 의뢰서 2026-07-01) — 사용자 수정 진입점.
       *  spaceId 가 있을 때만 활성 (synthetic / 익명 모드는 기존 placeholder). */}
      {spaceId && entity.kind === 'entity' && ledgerEntityKey ? (
        <>
          {/* ★ REQ-012-v2 (PO 2026-07-01 image #145) — 대표명 편집 진입점. */}
          <EntityNameEdit
            spaceId={spaceId}
            entityUid={ledgerEntityKey}
            currentName={entityName}
            onChanged={() => onEntityChanged?.()}
          />
          <EntityTypeDropdown
            spaceId={spaceId}
            entityUid={ledgerEntityKey}
            currentType={entityType}
            confidence={entity.entity_type_confidence ?? null}
            onChanged={() => onEntityChanged?.()}
          />
          <div
            data-testid="stellar-entity-card-merge-cta"
            style={{
              marginTop: 14,
              borderTop: `1px solid ${PANEL_BORDER}`,
              paddingTop: 14,
            }}
          >
            <button
              type="button"
              data-testid="stellar-entity-card-merge-open"
              onClick={() => setMergeOpen(true)}
              style={{
                width: '100%',
                background: 'rgba(94,234,212,0.05)',
                border: `1px dashed ${ACCENT}`,
                color: ACCENT,
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              비슷한 노드와 합치기 / 분리
            </button>
          </div>
          {mergeOpen ? (
            <MergeCandidatesModal
              spaceId={spaceId}
              anchorEntityUid={ledgerEntityKey}
              anchorPrimaryLabel={entityName}
              onClose={() => setMergeOpen(false)}
              onMerged={() => {
                setMergeOpen(false);
                onEntityChanged?.();
              }}
              onUnmerged={() => {
                setMergeOpen(false);
                onEntityChanged?.();
              }}
            />
          ) : null}
          {/* ★ REQ-012-v2 (PO 2026-07-01 image #145) — 노드 삭제 진입점.
           *  soft delete + 자동 fact retract. 되살리기는 v3. */}
          <EntityDeleteButton
            spaceId={spaceId}
            entityUid={ledgerEntityKey}
            primaryLabel={entityName}
            onDeleted={() => {
              onEntityChanged?.();
              onClose();
            }}
          />
        </>
      ) : (
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
          다음 단계 — 사용자 수동 통합/분리 (synthetic 모드 에서는 비활성).
        </div>
      )}
    </aside>
  );
}

export default StellarEntityCard;
