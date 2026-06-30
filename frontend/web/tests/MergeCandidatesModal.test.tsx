/**
 * REQ-012-v1 — MergeCandidatesModal unit tests.
 *
 * PO 의뢰서 verbatim:
 *   - 후보 제시 + 수동 선택 둘 다.
 *   - 광주 + 광주광역시 / 삼성전자 2개 사용자 병합.
 *   - 분리 (잘못 병합 되돌리기) 가능.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MergeCandidatesModal } from '@/components/MergeCandidatesModal';
import * as api from '@/lib/api';

describe('MergeCandidatesModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders fetched candidates from the backend', async () => {
    vi.spyOn(api, 'fetchMergeCandidates').mockResolvedValue([
      {
        entity_uid: 'ent-B',
        primary_label: '광주광역시',
        entity_type: 'location',
        score: 5.2,
        reason: 'same prefix + same type',
      },
    ]);
    render(
      <MergeCandidatesModal
        spaceId="space-1"
        anchorEntityUid="ent-A"
        anchorPrimaryLabel="광주"
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      const candidates = screen.getAllByTestId('merge-modal-candidate');
      expect(candidates.length).toBe(1);
      expect(candidates[0]?.textContent).toMatch(/광주광역시/);
    });
  });

  it('submits selected candidates as members + anchor (광주 + 광주광역시 case)', async () => {
    vi.spyOn(api, 'fetchMergeCandidates').mockResolvedValue([
      {
        entity_uid: 'ent-B',
        primary_label: '광주광역시',
        entity_type: 'location',
        score: 5.2,
        reason: 'same prefix',
      },
    ]);
    const mergeSpy = vi.spyOn(api, 'mergeEntities').mockResolvedValue({
      canonical_uid: 'ent-A',
      primary_label: '광주',
      entity_type: 'location',
      aliases: ['광주광역시'],
      members_retired: ['ent-B'],
      facts_rewritten: {
        subjects_remapped: 2,
        objects_remapped: 0,
        facts_touched: 2,
      },
      merged_at: '2026-07-01T00:00:00Z',
    });
    const onMerged = vi.fn();
    render(
      <MergeCandidatesModal
        spaceId="space-1"
        anchorEntityUid="ent-A"
        anchorPrimaryLabel="광주"
        onClose={() => {}}
        onMerged={onMerged}
      />,
    );
    await waitFor(() => screen.getByTestId('merge-modal-candidate'));
    const checkbox = screen.getByTestId('merge-candidate-toggle-ent-B');
    fireEvent.click(checkbox);
    const submit = screen.getByTestId('merge-modal-submit');
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(mergeSpy).toHaveBeenCalledWith(
      'space-1',
      'ent-A',
      ['ent-A', 'ent-B'],
      expect.objectContaining({ reason: 'user_manual_merge_via_modal' }),
    );
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('merge-result-banner').textContent).toMatch(/병합 완료/);
  });

  it('accepts manual entity uid entries', async () => {
    vi.spyOn(api, 'fetchMergeCandidates').mockResolvedValue([]);
    render(
      <MergeCandidatesModal
        spaceId="space-1"
        anchorEntityUid="ent-A"
        anchorPrimaryLabel="삼성전자"
        onClose={() => {}}
      />,
    );
    await waitFor(() => screen.getByTestId('merge-modal-candidates-empty'));
    const input = screen.getByTestId('merge-modal-manual-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ent-C' } });
    fireEvent.click(screen.getByTestId('merge-modal-manual-add'));
    expect(screen.getByTestId('merge-modal-manual-list').textContent).toMatch(/ent-C/);
  });

  it('calls unmergeEntity on 되돌리기 button', async () => {
    vi.spyOn(api, 'fetchMergeCandidates').mockResolvedValue([]);
    const unmergeSpy = vi.spyOn(api, 'unmergeEntity').mockResolvedValue({
      canonical_uid: 'ent-A',
      members_restored: ['ent-B'],
      aliases_after: [],
      facts_reverted: {
        subjects_reverted: 0,
        objects_reverted: 0,
        facts_touched: 2,
      },
      unmerged_at: '2026-07-01T00:01:00Z',
    });
    const onUnmerged = vi.fn();
    render(
      <MergeCandidatesModal
        spaceId="space-1"
        anchorEntityUid="ent-A"
        anchorPrimaryLabel="광주"
        onClose={() => {}}
        onUnmerged={onUnmerged}
      />,
    );
    await waitFor(() => screen.getByTestId('merge-modal-candidates-empty'));
    const unmergeBtn = screen.getByTestId('merge-modal-unmerge');
    await act(async () => {
      fireEvent.click(unmergeBtn);
    });
    expect(unmergeSpy).toHaveBeenCalledWith(
      'space-1', 'ent-A', 'user_manual_unmerge_via_modal',
    );
    expect(onUnmerged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('unmerge-result-banner').textContent).toMatch(/분리 완료/);
  });
});
