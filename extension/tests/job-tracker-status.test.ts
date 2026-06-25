/**
 * feat/state-sync-unification — heartbeat status-label regression.
 *
 * PO #4 / #5: the popup shows "저장 중" / "분석 중" for ages while the
 * backend has long since flipped the source row to structured. Without
 * the source-of-truth poll (out of scope here), the label at least
 * needs to advertise its own staleness so the user knows to go check
 * the pending queue manually.
 */
import { describe, expect, it } from 'vitest';
import {
  ANALYZING_STALE_MS,
  SAVING_STALE_MS,
  statusLabel,
} from '@/background/job-tracker';

describe('statusLabel — heartbeat staleness', () => {
  it('fresh saving row reads as normal 저장 중…', () => {
    expect(statusLabel('saving', 1_000)).toBe('저장 중…');
  });

  it('stuck saving row past 60s flags 확인 필요', () => {
    expect(statusLabel('saving', SAVING_STALE_MS + 1)).toBe('저장 중… (확인 필요)');
  });

  it('fresh analyzing row reads as normal 분석 중…', () => {
    expect(statusLabel('analyzing', 30_000)).toBe('분석 중…');
  });

  it('stuck analyzing row past 5min flags 지연', () => {
    expect(statusLabel('analyzing', ANALYZING_STALE_MS + 1)).toBe('분석 중… (지연)');
  });

  it('completed always reads 완료 — terminal never escalates', () => {
    expect(statusLabel('completed', 999_999_999)).toBe('완료');
  });

  it('failed always reads 실패 — terminal never escalates', () => {
    expect(statusLabel('failed', 999_999_999)).toBe('실패');
  });
});
