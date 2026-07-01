/**
 * REQ-012-v2 — EntityDeleteButton unit tests.
 *
 * PO 의뢰서: "사용자가 노드와 엣지를 선택하고 delete 를 하고 싶다면?"
 * → soft delete + 확인 다이얼로그.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EntityDeleteButton } from '@/components/EntityDeleteButton';
import * as api from '@/lib/api';

describe('EntityDeleteButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the open button first, hides the confirm block', () => {
    render(
      <EntityDeleteButton
        spaceId="space-1"
        entityUid="ent-1"
        primaryLabel="테스트 노드"
      />,
    );
    expect(screen.getByTestId('entity-delete-open')).toBeTruthy();
    expect(screen.queryByTestId('entity-delete-confirm')).toBeNull();
  });

  it('shows the confirm block after click, and cancel returns to open', () => {
    render(
      <EntityDeleteButton
        spaceId="space-1"
        entityUid="ent-1"
        primaryLabel="테스트 노드"
      />,
    );
    fireEvent.click(screen.getByTestId('entity-delete-open'));
    expect(screen.getByTestId('entity-delete-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('entity-delete-cancel'));
    expect(screen.queryByTestId('entity-delete-confirm')).toBeNull();
    expect(screen.getByTestId('entity-delete-open')).toBeTruthy();
  });

  it('calls deleteEntity + onDeleted on submit', async () => {
    const spy = vi.spyOn(api, 'deleteEntity').mockResolvedValue({
      entity_uid: 'ent-1',
      primary_label: '테스트 노드',
      retired_at: '2026-07-01T00:00:00Z',
      facts_retracted: 2,
    });
    const onDeleted = vi.fn();
    render(
      <EntityDeleteButton
        spaceId="space-1"
        entityUid="ent-1"
        primaryLabel="테스트 노드"
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByTestId('entity-delete-open'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('entity-delete-submit'));
    });
    expect(spy).toHaveBeenCalledWith(
      'space-1', 'ent-1', 'user_delete_via_stellar',
    );
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ facts_retracted: 2 }),
    );
  });

  it('surfaces server error, keeps the confirm block visible', async () => {
    vi.spyOn(api, 'deleteEntity').mockRejectedValue(new Error('403 forbidden'));
    render(
      <EntityDeleteButton
        spaceId="space-1"
        entityUid="ent-1"
        primaryLabel="테스트 노드"
      />,
    );
    fireEvent.click(screen.getByTestId('entity-delete-open'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('entity-delete-submit'));
    });
    expect(screen.getByTestId('entity-delete-error').textContent)
      .toMatch(/403 forbidden/);
    expect(screen.getByTestId('entity-delete-confirm')).toBeTruthy();
  });
});
