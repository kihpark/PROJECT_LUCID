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
 * ★ REQ-013 (PO 2026-07-02) — 드롭다운 가독성 (recurring). 옛 native <select>
 *   는 브라우저 (특히 Chromium) 가 <option> CSS 를 부분적으로만 적용 → 흰
 *   배경 + 밝은 회색 텍스트가 지속됨. b67e05f 의 inline style fix 도 회귀.
 *   → native <select> 폐기. 커스텀 dropdown (button trigger + absolute <ul>
 *   listbox) 로 재구현 → 다크 팔레트를 완전히 제어.
 *   - trigger = <button data-testid="entity-type-select">
 *   - open panel = <ul data-testid="entity-type-listbox">
 *   - each option = <li><button data-testid="entity-type-option-{value}">
 *   - close on outside click + Esc + option select.
 *
 * 진입자리:
 *   - StellarEntityCard (지식그래프 노드 → 우패널)
 *   - LedgerCard (기록 → entity 클릭 — v2)
 *   - RecallEvidenceCard (검색 → entity 클릭 — v2)
 */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';
const PANEL_BG = '#0b1114';
const PANEL_BORDER = '#1c272b';
const ATTENTION = '#f6c177';
const HOVER_BG = 'rgba(94,234,212,0.10)';

/** PO 의뢰서: "AI confidence 표시 + 낮으면 확인 필요 유도". */
const CONFIDENCE_LOW_THRESHOLD = 0.55;

function labelForValue(value: string): string {
  const opt = ENTITY_TYPE_OPTIONS.find((o) => o.value === value);
  if (!opt) return value || '(선택)';
  return `${opt.label} (${opt.value})`;
}

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

  // ★ REQ-013 — custom dropdown state.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelected((currentType ?? '').trim().toLowerCase());
  }, [currentType, entityUid]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const lowConfidence =
    typeof confidence === 'number' && confidence < CONFIDENCE_LOW_THRESHOLD;

  const currentNormalized = (currentType ?? '').trim().toLowerCase();
  const dirty = Boolean(selected) && selected !== currentNormalized;

  const onSelectOption = useCallback((value: string) => {
    setSelected(value);
    setOpen(false);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty) return;
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

  const triggerLabel = selected ? labelForValue(selected) : '(선택)';

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
        타입 변경
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
      <div
        ref={rootRef}
        style={{ display: 'flex', gap: 6, alignItems: 'stretch', position: 'relative' }}
      >
        {/* ★ REQ-013 (PO 2026-07-02) — custom trigger. data-testid preserved
         *  so Playwright / vitest specs keyed off entity-type-select continue
         *  to work. aria-haspopup + aria-expanded 로 A11y 유지. */}
        <button
          type="button"
          data-testid="entity-type-select"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={saving}
          onClick={() => setOpen((v) => !v)}
          style={{
            flex: 1,
            background: PANEL_BG,
            color: selected ? TEXT_PRIMARY : TEXT_DIM,
            border: `1px solid ${PANEL_BORDER}`,
            borderRadius: 6,
            padding: '6px 8px',
            fontSize: 12,
            fontFamily: 'Pretendard, sans-serif',
            cursor: saving ? 'not-allowed' : 'pointer',
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
          }}
        >
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {triggerLabel}
          </span>
          <span
            aria-hidden="true"
            style={{
              color: TEXT_DIM,
              fontSize: 10,
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 120ms ease',
            }}
          >
            ▾
          </span>
        </button>
        <button
          type="submit"
          data-testid="entity-type-save"
          disabled={saving || !dirty}
          style={{
            background: 'rgba(94,234,212,0.08)',
            border: `1px solid ${ACCENT}`,
            color: ACCENT,
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor: saving || !dirty ? 'not-allowed' : 'pointer',
            opacity: saving || !dirty ? 0.5 : 1,
          }}
        >
          {saving ? '저장 중…' : '저장'}
        </button>

        {open ? (
          <ul
            data-testid="entity-type-listbox"
            role="listbox"
            style={{
              listStyle: 'none',
              padding: 4,
              margin: 0,
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 60,
              background: PANEL_BG,
              border: `1px solid ${PANEL_BORDER}`,
              borderRadius: 8,
              maxHeight: 260,
              overflowY: 'auto',
              zIndex: 40,
              boxShadow: '0 12px 24px rgba(0,0,0,0.55)',
              backdropFilter: 'blur(6px)',
            }}
          >
            {ENTITY_TYPE_OPTIONS.map((opt) => {
              const isSelected = opt.value === selected;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-testid={`entity-type-option-${opt.value}`}
                    onClick={() => onSelectOption(opt.value)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: isSelected ? HOVER_BG : 'transparent',
                      border: `1px solid ${isSelected ? ACCENT : 'transparent'}`,
                      borderRadius: 6,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      color: isSelected ? ACCENT : TEXT_BODY,
                      fontSize: 12,
                      fontFamily: 'Pretendard, sans-serif',
                      display: 'block',
                    }}
                    onMouseEnter={(e) => {
                      if (isSelected) return;
                      e.currentTarget.style.background = HOVER_BG;
                      e.currentTarget.style.color = ACCENT;
                    }}
                    onMouseLeave={(e) => {
                      if (isSelected) return;
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = TEXT_BODY;
                    }}
                  >
                    {opt.label} <span style={{ color: TEXT_DIM }}>({opt.value})</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
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
