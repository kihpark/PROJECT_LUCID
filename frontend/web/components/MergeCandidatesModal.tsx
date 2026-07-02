/**
 * REQ-012-v1 기능 B — 노드 합치기 모달.
 *
 * PO 의뢰서 verbatim:
 *   - 광주 + 광주광역시 / 삼성전자 2개 사용자 병합.
 *   - 한 canonical entity, alias 보존, 연결 fact 이전.
 *   - merge_provenance 기록 (★ 되돌릴 수 있게 v3 §7).
 *   - 후보 제시 + 수동 선택 둘 다.
 *   - 분리 (잘못 병합 되돌리기) 가능.
 *
 * UX:
 *   1) anchor entity 가 canonical 후보 — 사용자가 다른 후보를 toggle.
 *   2) "후보 제시" = 백엔드 prefix surface 검색.
 *   3) "수동 입력" = 사용자가 entity_uid 직접 추가 (★ STELLAR/LEDGER 에서
 *      복사한 uid). v2 에서 검색-기반 picker 로 교체.
 *   4) "병합" 버튼 — POST /entities/merge → 결과 banner.
 *   5) "되돌리기" 버튼 — POST /entities/unmerge → 결과 banner.
 */
'use client';

import { useEffect, useState } from 'react';
import {
  fetchMergeCandidates,
  mergeEntities,
  unmergeEntity,
  ApiError,
  type MergeCandidate,
  type EntityMergeResult,
  type EntityUnmergeResult,
} from '@/lib/api';

export interface MergeCandidatesModalProps {
  spaceId: string;
  /** Anchor entity (the user clicked this one) — defaults to canonical. */
  anchorEntityUid: string;
  anchorPrimaryLabel: string;
  onClose: () => void;
  /** Called after a successful merge OR unmerge so the parent can refresh
   *  the graph + close the modal. */
  onMerged?: (result: EntityMergeResult) => void;
  onUnmerged?: (result: EntityUnmergeResult) => void;
}

const ACCENT = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';
const PANEL_BG = 'rgba(12,19,22,0.96)';
const PANEL_BORDER = '#1c272b';
const ATTENTION = '#f6c177';

export function MergeCandidatesModal({
  spaceId,
  anchorEntityUid,
  anchorPrimaryLabel,
  onClose,
  onMerged,
  onUnmerged,
}: MergeCandidatesModalProps) {
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualUid, setManualUid] = useState('');
  const [manualEntries, setManualEntries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mergeResult, setMergeResult] = useState<EntityMergeResult | null>(
    null,
  );
  const [unmergeResult, setUnmergeResult] = useState<EntityUnmergeResult | null>(
    null,
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchMergeCandidates(spaceId, anchorEntityUid)
      .then((items) => setCandidates(items))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [spaceId, anchorEntityUid]);

  function toggle(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function addManual() {
    const v = manualUid.trim();
    if (!v) return;
    if (v === anchorEntityUid) return;
    if (manualEntries.includes(v)) return;
    setManualEntries((prev) => [...prev, v]);
    setSelected((prev) => new Set([...prev, v]));
    setManualUid('');
  }

  async function handleMerge() {
    const otherMembers = [
      ...candidates.filter((c) => selected.has(c.entity_uid)).map((c) => c.entity_uid),
      ...manualEntries.filter((u) => selected.has(u)),
    ];
    if (otherMembers.length === 0) return;
    const members = Array.from(new Set([anchorEntityUid, ...otherMembers]));
    setBusy(true);
    setError(null);
    try {
      const result = await mergeEntities(spaceId, anchorEntityUid, members, {
        reason: 'user_manual_merge_via_modal',
      });
      setMergeResult(result);
      onMerged?.(result);
    } catch (err) {
      // ★ REQ-014-D (PO 2026-07-02) — 409 informative surface.
      //   옛: "API 409 on /entities/merge" — 사용자가 왜 실패했는지 알 길 없음.
      //   fix: backend 가 이미 detail dict 로 code/message/merged_into_* 를
      //   보낸다. ApiError.detail (message) 을 우선 노출, dict payload 도
      //   지문화 하이라이트로 함께 안내한다. 병합 대상이 이미 다른 canonical
      //   로 흡수됐다면 "이미 X 로 병합됨. 그래프를 새로고침 하세요." 안내.
      if (err instanceof ApiError && err.status === 409 && err.detail) {
        setError(`병합 실패 (409): ${err.detail}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleUnmerge() {
    setBusy(true);
    setError(null);
    try {
      const result = await unmergeEntity(spaceId, anchorEntityUid,
        'user_manual_unmerge_via_modal');
      setUnmergeResult(result);
      onUnmerged?.(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="merge-modal-overlay"
      role="dialog"
      aria-label="entity merge"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        data-testid="merge-modal"
        style={{
          background: PANEL_BG,
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 14,
          padding: 22,
          width: 540,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          color: TEXT_PRIMARY,
          boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
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
            노드 합치기 / 분리
          </span>
          <button
            type="button"
            data-testid="merge-modal-close"
            onClick={onClose}
            aria-label="close"
            style={{
              background: 'transparent',
              border: 'none',
              color: TEXT_DIM,
              fontSize: 18,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </header>

        <div data-testid="merge-modal-anchor" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: TEXT_DIM, letterSpacing: '0.08em' }}>
            CANONICAL (살아남을 대표)
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: ACCENT,
              marginTop: 2,
            }}
          >
            {anchorPrimaryLabel}
          </div>
          <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 2 }}>
            {anchorEntityUid}
          </div>
        </div>

        {mergeResult ? (
          <div
            data-testid="merge-result-banner"
            style={{
              background: 'rgba(94,234,212,0.08)',
              border: `1px solid ${ACCENT}`,
              borderRadius: 6,
              padding: 10,
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            병합 완료 · {mergeResult.members_retired.length}개 흡수 ·{' '}
            {mergeResult.facts_rewritten.facts_touched}개 fact 이전 · alias{' '}
            {mergeResult.aliases.length}개 보존
          </div>
        ) : null}

        {unmergeResult ? (
          <div
            data-testid="unmerge-result-banner"
            style={{
              background: 'rgba(246,193,119,0.08)',
              border: `1px solid ${ATTENTION}`,
              borderRadius: 6,
              padding: 10,
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            분리 완료 · {unmergeResult.members_restored.length}개 복원 ·{' '}
            {unmergeResult.facts_reverted.facts_touched}개 fact provenance 해제
          </div>
        ) : null}

        {!mergeResult && !unmergeResult ? (
          <>
            <section data-testid="merge-modal-candidates" style={{ marginTop: 6 }}>
              <div
                style={{
                  fontSize: 10,
                  color: TEXT_DIM,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                AI 후보 (prefix surface 매칭)
              </div>
              {loading ? (
                <div style={{ fontSize: 12, color: TEXT_DIM }}>로딩 중…</div>
              ) : candidates.length === 0 ? (
                <div
                  data-testid="merge-modal-candidates-empty"
                  style={{ fontSize: 12, color: TEXT_DIM }}
                >
                  비슷한 entity 후보 없음
                </div>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {candidates.map((c) => (
                    <li
                      key={c.entity_uid}
                      data-testid="merge-modal-candidate"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderBottom: `1px solid ${PANEL_BORDER}`,
                      }}
                    >
                      <input
                        type="checkbox"
                        data-testid={`merge-candidate-toggle-${c.entity_uid}`}
                        checked={selected.has(c.entity_uid)}
                        onChange={() => toggle(c.entity_uid)}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: TEXT_PRIMARY }}>
                          {c.primary_label}
                        </div>
                        <div style={{ fontSize: 10, color: TEXT_DIM }}>
                          {c.entity_type ?? '(미지)'} · {c.reason}
                        </div>
                      </div>
                      <div style={{ fontSize: 10, color: TEXT_DIM }}>
                        {c.score.toFixed(1)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section data-testid="merge-modal-manual" style={{ marginTop: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  color: TEXT_DIM,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                수동 선택 (entity uid 직접 입력)
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  data-testid="merge-modal-manual-input"
                  value={manualUid}
                  onChange={(e) => setManualUid(e.target.value)}
                  placeholder="entity uid"
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
                  type="button"
                  data-testid="merge-modal-manual-add"
                  onClick={addManual}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: TEXT_BODY,
                    border: `1px solid ${PANEL_BORDER}`,
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  추가
                </button>
              </div>
              {manualEntries.length > 0 ? (
                <ul
                  data-testid="merge-modal-manual-list"
                  style={{ listStyle: 'none', padding: 0, marginTop: 6 }}
                >
                  {manualEntries.map((u) => (
                    <li
                      key={u}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px',
                        fontSize: 12,
                        color: TEXT_BODY,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(u)}
                        onChange={() => toggle(u)}
                      />
                      <span style={{ fontFamily: 'monospace' }}>{u}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </>
        ) : null}

        {error ? (
          <div
            data-testid="merge-modal-error"
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 6,
              background: 'rgba(255,111,111,0.08)',
              border: '1px solid #ff6f6f',
              color: '#ff6f6f',
              fontSize: 12,
            }}
          >
            오류: {error}
          </div>
        ) : null}

        <footer
          style={{
            marginTop: 18,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <button
            type="button"
            data-testid="merge-modal-unmerge"
            disabled={busy}
            onClick={handleUnmerge}
            style={{
              background: 'rgba(246,193,119,0.08)',
              border: `1px solid ${ATTENTION}`,
              color: ATTENTION,
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >
            가장 최근 합치기 되돌리기
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              data-testid="merge-modal-cancel"
              onClick={onClose}
              disabled={busy}
              style={{
                background: 'transparent',
                border: `1px solid ${PANEL_BORDER}`,
                color: TEXT_DIM,
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              닫기
            </button>
            <button
              type="button"
              data-testid="merge-modal-submit"
              disabled={busy || selected.size === 0}
              onClick={handleMerge}
              style={{
                background: 'rgba(94,234,212,0.08)',
                border: `1px solid ${ACCENT}`,
                color: ACCENT,
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor:
                  busy || selected.size === 0 ? 'not-allowed' : 'pointer',
                opacity: busy || selected.size === 0 ? 0.5 : 1,
              }}
            >
              {busy
                ? '병합 중…'
                : `${selected.size}개와 합치기`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default MergeCandidatesModal;
