/**
 * M3-2d 호버 카드 (PO 의뢰서 verbatim + 2026-06-28 정정 + 데이터모델 v2 반영).
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

const MODALITY_LABEL: Record<ClaimModality, string> = {
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

const FACT_TYPE_KO: Record<'action' | 'claim' | 'measurement', string> = {
  action: '행위',
  claim: '발화',
  measurement: '수치',
};

function FactTypeBadge({
  factType,
  modality,
}: {
  factType: 'action' | 'claim' | 'measurement';
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
  const subject = fact.subject || '(주체 없음)';
  const predicate = predicateLabel(fact.predicate);
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
  const speaker = fact.speaker_label?.trim() || fact.subject || '(주체 없음)';
  const speechAct = fact.speech_act?.trim() || '말함';
  const modality = classifyClaimModality(fact.speech_act);
  const verbLine = modality ? MODALITY_LABEL[modality] : speechAct;
  const content = fact.content_claim?.trim() || fact.object || '';
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
        style={{ color: TEXT_BODY, marginTop: 4, fontStyle: 'italic' }}
      >
        “{truncate(content, 100)}”
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
  const entity = fact.subject || '(주체 없음)';
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

export interface StellarHoverCardProps {
  fact: StellarNode;
  position: { x: number; y: number };
}

export function StellarHoverCard({ fact, position }: StellarHoverCardProps) {
  const factType = (fact.fact_type ?? 'action') as
    | 'action'
    | 'claim'
    | 'measurement';
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
      {factType === 'action' ? <ActionBody fact={fact} /> : null}
      {factType === 'claim' ? <ClaimBody fact={fact} /> : null}
      {factType === 'measurement' ? <MeasurementBody fact={fact} /> : null}
      <CardFooter asOf={fact.as_of} />
    </div>
  );
}

export default StellarHoverCard;
