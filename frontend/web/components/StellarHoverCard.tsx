/**
 * M3-2d 호버 카드 (PO 의뢰서 verbatim + 2026-06-28 정정 + 데이터모델 v2 반영
 *   + fix/stellar-cards-entity-node-compat 2026-06-29).
 *
 * ★ 단일 SPO 카드. 다른 라벨 모두 제거 — 중복 오버레이 0.
 *
 * ★ PO 정정 spec (2026-06-28):
 *   모든 fact = 검증된 사실 = 실선 / 또렷.
 *   link_status (verified/claimed) = 데이터 메타데이터 only — 시각 강약 X.
 *
 * ★ 데이터모델 v2 (PO 2026-06-28):
 *   CLAIM 양태 (modality) 3종 → speech_act 필드로 분류:
 *     - assertion : 단정
 *     - judgment  : 판단·견해
 *     - opinion   : 추측·의견
 *   speech_act 가 위 세 키워드 중 하나면 양태 라벨을 노출.
 *   기타 값은 동사 그대로 (예: 발표했다).
 *
 * ★ fix/stellar-cards-entity-node-compat (PO 2026-06-29):
 *   STELLAR v2 의 entity-node / claim-node 모델을 카드가 직접 읽도록 분기.
 *   - kind === 'entity' → EntityBody (label + entity_type + degree).
 *   - kind === 'claim'  → ClaimEntityBody (speaker_label + speech_act + content_claim).
 *   - kind === undefined → 기존 ActionBody/ClaimBody/MeasurementBody (synthetic/legacy).
 *   ★ '(주체 없음)' 문자열 제거. 모든 주체-이름 fallback 은 pickEntityName 으로 통합.
 *
 * ★ V3b (STELLAR 발언 truncate 가시화, 2026-06-29):
 *   ClaimBody / ClaimEntityBody 는 hover 비용을 위해 content 를 100자
 *   까지 truncate. truncate 일 때 '더 보기' hint 를 노출.
 *
 * ★ V4 (hover/click 일관성, 2026-06-29):
 *   EntityBody 가 fact_counts 가 있으면 행동/발언/수치 breakdown 노출.
 *   click 카드 (StellarEntityCard) 와 동일한 source.
 */
'use client';

import type { StellarNode } from '@/lib/syntheticGraph';
import { predicateLabel } from '@/lib/predicateLabels';

const ACCENT = '#5EEAD4';
const WHO_COLOR = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';
const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';

export type ClaimModality = 'assertion' | 'judgment' | 'opinion';

export const MODALITY_LABEL: Record<ClaimModality, string> = {
  assertion: '단정',
  judgment: '판단',
  opinion: '의견',
};

export function classifyClaimModality(
  speechAct: string | null | undefined,
): ClaimModality | null {
  if (!speechAct) return null;
  const v = speechAct.trim().toLowerCase();
  if (v === 'assertion' || v === 'assert' || v === 'assertions') return 'assertion';
  if (v === 'judgment' || v === 'judgement' || v === 'judge') return 'judgment';
  if (v === 'opinion' || v === 'opine' || v === 'opinions') return 'opinion';
  return null;
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function formatMeasurementValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return v.toFixed(2).replace(/\.?0+$/, '');
}

/** fix/stellar-cards-entity-node-compat — central entity-name picker.
 *  Used by every v2 + legacy branch so we never display '(주체 없음)'.
 *
 *  Precedence (v2 + legacy compatible):
 *    1. node.subject_label  — explicit display label for an entity ref.
 *    2. node.subject         — legacy / synthetic subject string.
 *    3. node.label           — v2 entity / claim node label.
 *    4. node.id (first 8)    — last-resort uid stub.
 *
 *  Why subject before label: legacy / synthetic nodes carry composite labels
 *  (e.g. "강재호 · 어떤객체") and a clean subject string ("강재호"); existing
 *  tests + the in-canvas hover pin the cleaner one. v2 entity / claim nodes
 *  leave `subject` undefined → label is consulted next.
 */
export function pickEntityName(node: StellarNode): string {
  const subjectLabel = (node as { subject_label?: unknown }).subject_label;
  if (typeof subjectLabel === 'string' && subjectLabel.trim().length > 0) {
    return subjectLabel.trim();
  }
  if (typeof node.subject === 'string' && node.subject.trim().length > 0) {
    return node.subject.trim();
  }
  const labelLike = (node as { label?: unknown }).label;
  if (typeof labelLike === 'string' && labelLike.trim().length > 0) {
    return labelLike.trim();
  }
  if (typeof node.id === 'string' && node.id.length > 0) {
    return node.id.slice(0, 8);
  }
  return '?';
}

const FACT_TYPE_KO: Record<'action' | 'claim' | 'measurement' | 'entity', string> = {
  action: '행위',
  claim: '발언',
  measurement: '수치',
  entity: '엔티티',
};

function FactTypeBadge({
  factType,
  modality,
}: {
  factType: 'action' | 'claim' | 'measurement' | 'entity';
  modality: ClaimModality | null;
}) {
  const text = modality
    ? FACT_TYPE_KO[factType] + ' · ' + MODALITY_LABEL[modality]
    : FACT_TYPE_KO[factType];
  return (
    <div
      data-testid="stellar-hover-card-badge"
      data-fact-type={factType}
      data-modality={modality ?? ''}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: 'rgba(94,234,212,0.14)',
        border: `1px solid ${ACCENT}`,
        borderRadius: 999,
        color: ACCENT,
        fontSize: 10,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontWeight: 600,
        marginBottom: 6,
      }}
    >
      {text}
    </div>
  );
}

function CardFooter({ asOf }: { asOf: string | null | undefined }) {
  if (!asOf) return null;
  return (
    <div
      data-testid="stellar-hover-card-foot"
      style={{ color: TEXT_DIM, fontSize: 10, marginTop: 6 }}
    >
      · {asOf}
    </div>
  );
}

function ActionBody({ fact }: { fact: StellarNode }) {
  const subject = pickEntityName(fact);
  const predicate = predicateLabel(fact.predicate ?? '');
  const object = truncate(fact.object, 90);
  const roles = fact.roles ?? null;
  return (
    <div>
      <div
        data-testid="stellar-hover-card-subject"
        style={{ color: WHO_COLOR, fontWeight: 600 }}
      >
        {subject}
      </div>
      <div
        data-testid="stellar-hover-card-predicate"
        style={{ color: ACCENT, fontSize: 11, marginTop: 2, fontWeight: 600 }}
      >
        → {predicate} →
      </div>
      <div
        data-testid="stellar-hover-card-object"
        style={{ color: TEXT_BODY, marginTop: 4 }}
      >
        {object}
      </div>
      {roles && Object.keys(roles).length > 0 ? (
        <div
          data-testid="stellar-hover-card-roles"
          style={{ color: TEXT_DIM, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}
        >
          roles:{' '}
          {Object.entries(roles)
            .map(([k, v]) => k + ': ' + v)
            .join(', ')}
        </div>
      ) : null}
    </div>
  );
}

function ClaimBody({ fact }: { fact: StellarNode }) {
  const speaker = fact.speaker_label?.trim() || pickEntityName(fact);
  const speechAct = fact.speech_act?.trim() || '말함';
  const modality = classifyClaimModality(fact.speech_act);
  const verbLine = modality ? MODALITY_LABEL[modality] : speechAct;
  const fullContent = fact.content_claim?.trim() || fact.object || '';
  // ★ fix/hover-full-content-no-deobogi (PO 2026-06-29):
  //   옛 V3b truncate + '더 보기' hint = UX 거짓 약속.
  //   사용자 마우스가 tooltip 위치로 가면 hover state 끝나 tooltip 사라짐
  //   → '더 보기' 클릭 불가능. 거짓 약속 제거하고 hover 도 full 표시.
  const relatedLabels =
    fact.related_entity_labels && fact.related_entity_labels.length > 0
      ? fact.related_entity_labels
      : null;
  return (
    <div>
      <div
        data-testid="stellar-hover-card-speaker"
        style={{ color: WHO_COLOR, fontWeight: 600 }}
      >
        {speaker}
      </div>
      <div
        data-testid="stellar-hover-card-speech-act"
        data-modality={modality ?? ''}
        style={{ color: ACCENT, fontSize: 11, marginTop: 2, fontWeight: 600 }}
      >
        {verbLine}
      </div>
      <div
        data-testid="stellar-hover-card-content"
        style={{
          color: TEXT_BODY,
          marginTop: 4,
          fontStyle: 'italic',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        “{fullContent}”
      </div>
      {relatedLabels ? (
        <div
          data-testid="stellar-hover-card-related"
          style={{ color: TEXT_DIM, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}
        >
          관련: {relatedLabels.join(', ')}
        </div>
      ) : null}
    </div>
  );
}

function MeasurementBody({ fact }: { fact: StellarNode }) {
  const entity = pickEntityName(fact);
  const metric = fact.metric?.trim() || '';
  const value =
    typeof fact.measurement_value === 'number'
      ? formatMeasurementValue(fact.measurement_value)
      : (fact.object || '').trim();
  const unit = fact.measurement_unit?.trim() || '';
  const valueLine = unit ? (value + ' ' + unit).trim() : value;
  return (
    <div>
      <div
        data-testid="stellar-hover-card-entity"
        style={{ color: WHO_COLOR, fontWeight: 600 }}
      >
        {entity}
      </div>
      <div
        data-testid="stellar-hover-card-metric"
        style={{ color: ACCENT, fontSize: 11, marginTop: 2, fontWeight: 600 }}
      >
        {metric} = {valueLine}
      </div>
    </div>
  );
}

/** fix/stellar-cards-entity-node-compat — v2 entity-node body.
 *  Hover over an entity node → name + entity_type + degree (+ measurements count). */
function EntityBody({ fact }: { fact: StellarNode }) {
  const name = pickEntityName(fact);
  const entityType =
    fact.entity_type?.trim() ||
    fact.subject_entity_type?.trim() ||
    '';
  const degree = typeof fact.degree === 'number' ? fact.degree : null;
  const measurementsCount = Array.isArray(fact.measurements)
    ? fact.measurements.length
    : 0;
  // ★ V4 — fact_counts is the same source the click card uses.
  const factCounts = fact.fact_counts ?? null;
  return (
    <div>
      <div
        data-testid="stellar-hover-card-entity-name"
        style={{ color: WHO_COLOR, fontWeight: 600 }}
      >
        {name}
      </div>
      <div
        data-testid="stellar-hover-card-entity-meta"
        style={{ color: TEXT_BODY, fontSize: 11, marginTop: 4, lineHeight: 1.5 }}
      >
        {entityType ? <span>{entityType}</span> : null}
        {factCounts ? (
          <>
            {entityType && degree !== null ? <br /> : null}
            {degree !== null ? <span>연결 {degree}</span> : null}
            <div data-testid="stellar-hover-card-entity-fact-counts">
              행동 {factCounts.action} · 발언 {factCounts.claim} · 수치 {factCounts.measurement}
            </div>
          </>
        ) : (
          <>
            {entityType && degree !== null ? (
              <span style={{ color: TEXT_DIM, margin: '0 6px' }}>·</span>
            ) : null}
            {degree !== null ? <span>연결 {degree}</span> : null}
            {measurementsCount > 0 ? (
              <>
                <span style={{ color: TEXT_DIM, margin: '0 6px' }}>·</span>
                <span data-testid="stellar-hover-card-entity-measurements-count">
                  수치 {measurementsCount}건
                </span>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** fix/stellar-cards-entity-node-compat — v2 claim-node body.
 *  Hover over a claim node → speaker_label + speech_act + content_claim
 *  (+ related entity labels). */
function ClaimEntityBody({ fact }: { fact: StellarNode }) {
  const speaker = fact.speaker_label?.trim() || '(화자 미상)';
  const speechAct = fact.speech_act?.trim() || '말함';
  const modality = classifyClaimModality(fact.speech_act);
  const verbLine = modality ? MODALITY_LABEL[modality] : speechAct;
  const fullContent = fact.content_claim?.trim() || fact.object || '';
  // ★ fix/hover-full-content-no-deobogi (PO 2026-06-29):
  //   옛 V3b truncate + '더 보기' hint = UX 거짓 약속.
  //   사용자 마우스가 tooltip 위치로 가면 hover state 끝나 tooltip 사라짐
  //   → '더 보기' 클릭 불가능. 거짓 약속 제거하고 hover 도 full 표시.
  const relatedLabels =
    fact.related_entity_labels && fact.related_entity_labels.length > 0
      ? fact.related_entity_labels
      : null;
  return (
    <div>
      <div
        data-testid="stellar-hover-card-speaker"
        style={{ color: WHO_COLOR, fontWeight: 600 }}
      >
        {speaker}
      </div>
      <div
        data-testid="stellar-hover-card-speech-act"
        data-modality={modality ?? ''}
        style={{ color: ACCENT, fontSize: 11, marginTop: 2, fontWeight: 600 }}
      >
        {verbLine}
      </div>
      <div
        data-testid="stellar-hover-card-content"
        style={{
          color: TEXT_BODY,
          marginTop: 4,
          fontStyle: 'italic',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        “{fullContent}”
      </div>
      {relatedLabels ? (
        <div
          data-testid="stellar-hover-card-related"
          style={{ color: TEXT_DIM, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}
        >
          관련: {relatedLabels.join(', ')}
        </div>
      ) : null}
    </div>
  );
}

export interface StellarHoverCardProps {
  fact: StellarNode;
  position: { x: number; y: number };
}

export function StellarHoverCard({ fact, position }: StellarHoverCardProps) {
  // fix/stellar-cards-entity-node-compat — branch on node.kind (v2) FIRST.
  // Legacy / synthetic nodes leave kind=undefined → fall through to the
  // existing fact_type branches so old tests + synthetic mode stay green.
  const kind = fact.kind;
  let factType: 'action' | 'claim' | 'measurement' | 'entity';
  if (kind === 'entity') {
    factType = 'entity';
  } else if (kind === 'claim') {
    factType = 'claim';
  } else {
    factType = (fact.fact_type ?? 'action') as 'action' | 'claim' | 'measurement';
  }
  const modality =
    factType === 'claim' ? classifyClaimModality(fact.speech_act) : null;

  return (
    <div
      data-testid="stellar-hover-card"
      data-fact-type={factType}
      data-modality={modality ?? ''}
      style={{
        position: 'fixed',
        top: position.y + 14,
        left: position.x + 14,
        zIndex: 30,
        maxWidth: 340,
        padding: '10px 12px',
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderLeft: `3px solid ${ACCENT}`,
        borderRadius: 10,
        color: TEXT_PRIMARY,
        pointerEvents: 'none',
        fontSize: 12,
        lineHeight: 1.45,
        boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
      }}
    >
      <FactTypeBadge factType={factType} modality={modality} />
      {factType === 'entity' ? <EntityBody fact={fact} /> : null}
      {kind === 'claim' ? <ClaimEntityBody fact={fact} /> : null}
      {kind === undefined && factType === 'action' ? <ActionBody fact={fact} /> : null}
      {kind === undefined && factType === 'claim' ? <ClaimBody fact={fact} /> : null}
      {kind === undefined && factType === 'measurement' ? (
        <MeasurementBody fact={fact} />
      ) : null}
      <CardFooter asOf={fact.as_of} />
    </div>
  );
}

export default StellarHoverCard;
