/**
 * REQ-012-v1 기능 A — entity 종류 드롭다운 (10종 closed set).
 *
 * PO 의뢰서 verbatim:
 *   - 10종 드롭다운 (person/organization/group/knowledge/resource/task/
 *     concept/event/metric/location)
 *   - 변경 즉시 그래프·색·형태 반영 (★ onChanged 후 부모가 재렌더)
 *   - 검증 행위로 기록 (★ 백엔드의 validation_logs + relabel_history)
 *   - AI confidence 표시 + 낮으면 "확인 필요" 유도 (★ AIConfidenceBadge)
 *
 * 진입자리:
 *   - StellarEntityCard (지식그래프 노드 → 우패널)
 *   - LedgerCard (기록 → entity 클릭 — v2)
 *   - RecallEvidenceCard (검색 → entity 클릭 — v2)
 */
'use client';

import { useState, useEffect } from 'react';
import {
  changeEntityType,
  ENTITY_TYPE_OPTIONS,
  type EntityTypeChangeResult,
} from '@/lib/api';

export interface EntityTypeDropdownProps {
  /** Knowledge space id (route param). */
  spaceId: string;
  /** Entity uid (object_uid in lucid_objects). */
  entityUid: string;
  /** Current entity_type (backend canonical token e.g. 'person'). */
  currentType: string | null | undefined;
  /** ★ AI confidence 0.0..1.0 — 낮으면 "확인 필요" 배너 표시. */
  confidence?: number | null;
  /** Called after a successful POST so the parent can re-fetch the graph
   *  and reflect the new color/shape immediately. */
  onChanged?: (result: EntityTypeChangeResult) => void;
}

const ACCENT = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_DIM = '#647479';
const PANEL_BORDER = '#1c272b';
const ATTENTION = '#f6c177';

/** PO 의뢰서: "AI confidence 표시 + 낮으면 확인 필요 유도". */
const CONFIDENCE_LOW_THRESHOLD = 0.55;

export function EntityTypeDropdown({
  spaceId,
  entityUid,
  currentType,
  confidence,
  onChanged,
}: EntityTypeDropdownProps) {
  const [selected, setSelected] = useState<string>(
    (currentType ?? '').trim().toLowerCase(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setSelected((currentType ?? '').trim().toLowerCase());
  }, [currentType, entityUid]);

  const lowConfidence =
    typeof confidence === 'number' && confidence < CONFIDENCE_LOW_THRESHOLD;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || selected === (currentType ?? '').trim().toLowerCase()) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await changeEntityType(spaceId, entityUid, selected);
      setSavedAt(result.updated_at);
      onChanged?.(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      data-testid="entity-type-dropdown"
      onSubmit={handleSubmit}
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
          textTransform: 'uppercase',
        }}
      >
        종류 변경
      </div>
      {lowConfidence ? (
        <div
          data-testid="entity-type-low-confidence"
          style={{
            fontSize: 11,
            color: ATTENTION,
            background: 'rgba(246,193,119,0.08)',
            border: `1px solid ${ATTENTION}`,
            borderRadius: 6,
            padding: '4px 8px',
            marginTop: 2,
          }}
        >
          AI 신뢰도 낮음 ({(confidence! * 100).toFixed(0)}%) — 확인 필요
        </div>
      ) : typeof confidence === 'number' ? (
        <div
          data-testid="entity-type-confidence"
          style={{ fontSize: 10, color: TEXT_DIM }}
        >
          AI 신뢰도 {(confidence * 100).toFixed(0)}%
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          data-testid="entity-type-select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={saving}
          style={{
            flex: 1,
            background: 'rgba(255,255,255,0.04)',
            color: TEXT_PRIMARY,
            border: `1px solid ${PANEL_BORDER}`,
            borderRadius: 6,
            padding: '6px 8px',
            fontSize: 12,
          }}
        >
          <option value="" disabled>
            (선택)
          </option>
          {ENTITY_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} ({opt.value})
            </option>
          ))}
        </select>
        <button
          type="submit"
          data-testid="entity-type-save"
          disabled={
            saving ||
            !selected ||
            selected === (currentType ?? '').trim().toLowerCase()
          }
          style={{
            background: 'rgba(94,234,212,0.08)',
            border: `1px solid ${ACCENT}`,
            color: ACCENT,
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor:
              saving ||
              !selected ||
              selected === (currentType ?? '').trim().toLowerCase()
                ? 'not-allowed'
                : 'pointer',
            opacity:
              saving ||
              !selected ||
              selected === (currentType ?? '').trim().toLowerCase()
                ? 0.5
                : 1,
          }}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
      {error ? (
        <div
          data-testid="entity-type-error"
          style={{ fontSize: 11, color: '#ff6f6f', marginTop: 2 }}
        >
          저장 실패: {error}
        </div>
      ) : null}
      {savedAt ? (
        <div
          data-testid="entity-type-saved"
          style={{ fontSize: 10, color: TEXT_DIM, marginTop: 2 }}
        >
          저장됨 · 그래프 즉시 반영
        </div>
      ) : null}
    </form>
  );
}

export default EntityTypeDropdown;
