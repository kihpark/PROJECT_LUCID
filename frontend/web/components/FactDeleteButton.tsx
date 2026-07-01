/**
 * REQ-012-v2 (PO 2026-07-01, image #145 dogfood) — fact (edge) 삭제 버튼.
 *
 * PO 명시: "사용자가 노드와 엣지를 선택하고 delete 를 하고 싶다면?"
 *
 * Fact soft delete = retract (retracted_at 스탬프). 옛 B-48b endpoint 재사용
 * (backend/api/routes/recall.py: POST /facts/{fact_uid}/retract). 이 버튼은
 * 사용자 mental model 에 맞춰 "삭제" 라벨을 씌운 얇은 래퍼.
 *
 * 진입자리:
 *   - LedgerCard 하단 (edge 삭제 자리)
 *   - RecallEvidenceCard 옆 (v3)
 *   - STELLAR edge context menu (v3)
 */
'use client';

import { useState } from 'react';
import { deleteFact } from '@/lib/api';

export interface FactDeleteButtonProps {
  spaceId: string;
  factUid: string;
  /** Called after a successful retract so the parent list can remove or
   *  strike-through the row. */
  onDeleted?: () => void;
  /** Optional inline mode — narrower footprint for LedgerCard footer. */
  inline?: boolean;
}

const DANGER = '#ff6f6f';
const TEXT_DIM = '#647479';
const PANEL_BORDER = '#1c272b';

export function FactDeleteButton({
  spaceId,
  factUid,
  onDeleted,
  inline = false,
}: FactDeleteButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setDeleting(true);
    setError(null);
    try {
      await deleteFact(spaceId, factUid);
      onDeleted?.();
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
        data-testid={`fact-delete-open-${factUid}`}
        onClick={() => setConfirming(true)}
        style={{
          background: 'transparent',
          border: `1px dashed ${DANGER}`,
          color: DANGER,
          borderRadius: 6,
          padding: inline ? '2px 8px' : '6px 10px',
          fontSize: inline ? 10 : 11,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        사실 삭제
      </button>
    );
  }

  return (
    <div
      data-testid={`fact-delete-confirm-${factUid}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        border: `1px solid ${PANEL_BORDER}`,
        borderRadius: 6,
        padding: 8,
        marginTop: 6,
      }}
    >
      <div style={{ fontSize: 11, color: DANGER, fontWeight: 600 }}>
        이 사실을 삭제할까요?
      </div>
      <div style={{ fontSize: 10, color: TEXT_DIM }}>
        기록에서 숨겨집니다. 되살릴 수 있습니다.
      </div>
      {error ? (
        <div
          data-testid={`fact-delete-error-${factUid}`}
          style={{ fontSize: 10, color: DANGER }}
        >
          삭제 실패: {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          data-testid={`fact-delete-cancel-${factUid}`}
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
            padding: '4px 8px',
            fontSize: 10,
            cursor: deleting ? 'not-allowed' : 'pointer',
          }}
        >
          취소
        </button>
        <button
          type="button"
          data-testid={`fact-delete-submit-${factUid}`}
          onClick={handleConfirm}
          disabled={deleting}
          style={{
            flex: 1,
            background: 'rgba(255,111,111,0.1)',
            border: `1px solid ${DANGER}`,
            color: DANGER,
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 10,
            fontWeight: 600,
            cursor: deleting ? 'not-allowed' : 'pointer',
            opacity: deleting ? 0.5 : 1,
          }}
        >
          {deleting ? '…' : '삭제'}
        </button>
      </div>
    </div>
  );
}

export default FactDeleteButton;
