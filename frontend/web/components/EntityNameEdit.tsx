/**
 * REQ-012-v2 (PO 2026-07-01, image #145 dogfood) — entity 대표명 편집.
 *
 * PO 명시:
 *   "한 총리 라고 되어 있는데, 사용자가 한성숙 으로 바꾸고 싶다면?"
 *
 * v3 §7 사용자 권한:
 *   - alias 추가 / 대표명 지정 / 통합 / 분리
 *   → 이 컴포넌트는 대표명 지정 (primary_label 갱신) + 옛 이름 alias 흡수
 *     를 담당한다. 통합/분리는 MergeCandidatesModal 이 그대로 담당.
 *
 * 진입자리:
 *   - StellarEntityCard (지식그래프 노드 → 우패널) — EntityTypeDropdown 위
 *   - RecallEntityEditModal (검색 → entity 클릭 오버레이) — 같은 자리
 */
'use client';

import { useEffect, useState } from 'react';
import {
  updateEntityName,
  type EntityNameChangeResult,
} from '@/lib/api';

export interface EntityNameEditProps {
  /** Knowledge space id (route param). */
  spaceId: string;
  /** Entity uid (object_uid in lucid_objects). */
  entityUid: string;
  /** Current primary_label — 저장 후 이 값이 aliases 로 흡수된다. */
  currentName: string;
  /** Optional callback so the parent can re-fetch STELLAR + RECALL. */
  onChanged?: (result: EntityNameChangeResult) => void;
}

const ACCENT = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_DIM = '#647479';
const PANEL_BORDER = '#1c272b';

export function EntityNameEdit({
  spaceId,
  entityUid,
  currentName,
  onChanged,
}: EntityNameEditProps) {
  const [value, setValue] = useState<string>(currentName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentName);
    setSavedAt(null);
    setError(null);
  }, [currentName, entityUid]);

  const dirty = value.trim().length > 0 && value.trim() !== currentName.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = value.trim();
    if (!next || next === currentName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateEntityName(spaceId, entityUid, next, {
        previousName: currentName,
      });
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
      data-testid="entity-name-edit"
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
        이름 변경
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          data-testid="entity-name-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
          maxLength={200}
          style={{
            flex: 1,
            background: 'rgba(255,255,255,0.04)',
            color: TEXT_PRIMARY,
            border: `1px solid ${PANEL_BORDER}`,
            borderRadius: 6,
            padding: '6px 8px',
            fontSize: 12,
          }}
        />
        <button
          type="submit"
          data-testid="entity-name-save"
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
      </div>
      {error ? (
        <div
          data-testid="entity-name-error"
          style={{ fontSize: 11, color: '#ff6f6f', marginTop: 2 }}
        >
          저장 실패: {error}
        </div>
      ) : null}
      {savedAt ? (
        <div
          data-testid="entity-name-saved"
          style={{ fontSize: 10, color: TEXT_DIM, marginTop: 2 }}
        >
          저장됨 · 옛 이름은 별칭으로 보존
        </div>
      ) : null}
    </form>
  );
}

export default EntityNameEdit;
