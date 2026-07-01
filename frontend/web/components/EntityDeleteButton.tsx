/**
 * REQ-012-v2 (PO 2026-07-01, image #145 dogfood) — entity 삭제 버튼 + 확인.
 *
 * PO 명시:
 *   "사용자가 노드와 엣지를 선택하고 delete 를 하고 싶다면?"
 *
 * v3 §7: delete 는 명시 없음. 다만 사용자 지식 정리 행위 정합.
 * 결정 (기획서): soft delete (retired_by_user 필드 세팅). fact 는 자동 retract.
 *
 * 진입자리:
 *   - StellarEntityCard (지식그래프 노드 → 우패널) — 카드 하단
 *   - RecallEntityEditModal (검색 → entity 오버레이) — 하단
 */
'use client';

import { useState } from 'react';
import { deleteEntity, type EntityDeleteResult } from '@/lib/api';

export interface EntityDeleteButtonProps {
  spaceId: string;
  entityUid: string;
  primaryLabel: string;
  /** Called after a successful DELETE so the parent can close the card +
   *  refetch the graph so the node disappears. */
  onDeleted?: (result: EntityDeleteResult) => void;
}

const DANGER = '#ff6f6f';
const TEXT_DIM = '#647479';
const PANEL_BORDER = '#1c272b';

export function EntityDeleteButton({
  spaceId,
  entityUid,
  primaryLabel,
  onDeleted,
}: EntityDeleteButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteEntity(
        spaceId,
        entityUid,
        'user_delete_via_stellar',
      );
      onDeleted?.(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        data-testid="entity-delete-open"
        onClick={() => setConfirming(true)}
        style={{
          width: '100%',
          background: 'transparent',
          border: `1px dashed ${DANGER}`,
          color: DANGER,
          borderRadius: 6,
          padding: '8px 10px',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          marginTop: 14,
          borderTop: `1px dashed ${DANGER}`,
        }}
      >
        노드 삭제
      </button>
    );
  }

  return (
    <div
      data-testid="entity-delete-confirm"
      style={{
        marginTop: 14,
        borderTop: `1px solid ${PANEL_BORDER}`,
        paddingTop: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: DANGER,
          fontWeight: 600,
          lineHeight: 1.4,
        }}
      >
        "{primaryLabel}" 노드를 삭제합니다
      </div>
      <div style={{ fontSize: 11, color: TEXT_DIM, lineHeight: 1.5 }}>
        연결된 사실도 함께 취소됩니다. 취소된 사실은 기록에서 되살릴 수 있습니다.
      </div>
      {error ? (
        <div
          data-testid="entity-delete-error"
          style={{ fontSize: 11, color: DANGER }}
        >
          삭제 실패: {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          data-testid="entity-delete-cancel"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={deleting}
          style={{
            flex: 1,
            background: 'transparent',
            border: `1px solid ${PANEL_BORDER}`,
            color: TEXT_DIM,
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            cursor: deleting ? 'not-allowed' : 'pointer',
          }}
        >
          취소
        </button>
        <button
          type="button"
          data-testid="entity-delete-submit"
          onClick={handleConfirm}
          disabled={deleting}
          style={{
            flex: 1,
            background: 'rgba(255,111,111,0.1)',
            border: `1px solid ${DANGER}`,
            color: DANGER,
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor: deleting ? 'not-allowed' : 'pointer',
            opacity: deleting ? 0.5 : 1,
          }}
        >
          {deleting ? '삭제 중…' : '삭제'}
        </button>
      </div>
    </div>
  );
}

export default EntityDeleteButton;
