'use client';

/**
 * ★ REQ-011-v2 (★ PO 2026-07-01) — Recall 근거 카드 → entity 수정 모달.
 *
 * 의뢰서 STEP 1.6 verbatim:
 *   - onSubjectClick → ★ REQ-012 의 EntityTypeDropdown + MergeModal 진입
 *   - ★ v2 = ★ ★ 옛 modal 진입 자리만 (★ v3 = 상세뷰 page)
 *
 * REQ-012-v1 의 entry point 두 가지 (EntityTypeDropdown + MergeCandidatesModal)
 * 를 Recall 화면 한 곳에서 띄우는 얇은 모달. StellarEntityCard 가 두 컴포넌트
 * 를 우패널 inline 으로 묶었다면, 여기서는 가벼운 "오버레이 + 안의 동일 컴포넌트"
 * 패턴으로 동일 기능을 노출한다. 변경된 backend 호출은 전부 EntityTypeDropdown /
 * MergeCandidatesModal 가 그대로 담당 — 본 모달은 진입 자리 / dispose 만.
 */

import { useState } from 'react';
import { EntityTypeDropdown } from './EntityTypeDropdown';
import { MergeCandidatesModal } from './MergeCandidatesModal';

const ACCENT = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_DIM = '#647479';
const PANEL_BG = 'rgba(12,19,22,0.96)';
const PANEL_BORDER = '#1c272b';

export interface RecallEntityEditModalProps {
  spaceId: string;
  /** subject_uid surface (from RecallFact.subject_uid). */
  entityUid: string;
  /** Display label — RecallFact.subject_label fallback to query token. */
  primaryLabel: string;
  /** Optional starting entity_type for the dropdown current value. */
  currentType?: string | null;
  onClose: () => void;
  /** Called after a successful type change OR merge — let RecallView
   *  re-run the recall query so the cards reflect the new graph. */
  onChanged?: () => void;
}

export function RecallEntityEditModal({
  spaceId,
  entityUid,
  primaryLabel,
  currentType,
  onClose,
  onChanged,
}: RecallEntityEditModalProps) {
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <div
      data-testid="recall-entity-edit-modal"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 96,
        zIndex: 80,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 92vw)',
          background: PANEL_BG,
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 14,
          padding: '20px 22px 24px',
          color: TEXT_PRIMARY,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <div>
            <div
              className="font-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.12em',
                color: ACCENT,
              }}
            >
              ENTITY
            </div>
            <div
              data-testid="recall-entity-edit-modal-label"
              style={{
                fontSize: 18,
                fontWeight: 600,
                marginTop: 3,
              }}
            >
              {primaryLabel}
            </div>
            <div
              data-testid="recall-entity-edit-modal-uid"
              className="font-mono"
              style={{ fontSize: 10, color: TEXT_DIM, marginTop: 3 }}
            >
              {entityUid}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            data-testid="recall-entity-edit-modal-close"
            style={{
              background: 'transparent',
              border: `1px solid ${PANEL_BORDER}`,
              color: TEXT_DIM,
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            닫기
          </button>
        </div>

        {/* REQ-012-v1 기능 A — entity 종류 변경. */}
        <EntityTypeDropdown
          spaceId={spaceId}
          entityUid={entityUid}
          currentType={currentType ?? null}
          onChanged={() => onChanged?.()}
        />

        {/* REQ-012-v1 기능 B — 노드 합치기 / 분리 진입. */}
        <div
          style={{
            marginTop: 14,
            borderTop: `1px solid ${PANEL_BORDER}`,
            paddingTop: 14,
          }}
        >
          <button
            type="button"
            data-testid="recall-entity-edit-modal-merge-open"
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
            anchorEntityUid={entityUid}
            anchorPrimaryLabel={primaryLabel}
            onClose={() => setMergeOpen(false)}
            onMerged={() => {
              setMergeOpen(false);
              onChanged?.();
            }}
            onUnmerged={() => {
              setMergeOpen(false);
              onChanged?.();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default RecallEntityEditModal;
