/**
 * REQ-012-v2 — FactDeleteButton unit tests.
 *
 * PO 명시: "엣지를 delete 하고 싶다면?" — fact soft delete = retract.
 * 백엔드는 옛 B-48b endpoint (POST /facts/{uid}/retract) 재사용.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { FactDeleteButton } from '@/components/FactDeleteButton';
import * as api from '@/lib/api';

describe('FactDeleteButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the open button first, hides the confirm block', () => {
    render(<FactDeleteButton spaceId="space-1" factUid="fact-1" />);
    expect(screen.getByTestId('fact-delete-open-fact-1')).toBeTruthy();
    expect(screen.queryByTestId('fact-delete-confirm-fact-1')).toBeNull();
  });

  it('shows the confirm block after click, cancel restores open', () => {
    render(<FactDeleteButton spaceId="space-1" factUid="fact-1" />);
    fireEvent.click(screen.getByTestId('fact-delete-open-fact-1'));
    expect(screen.getByTestId('fact-delete-confirm-fact-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('fact-delete-cancel-fact-1'));
    expect(screen.queryByTestId('fact-delete-confirm-fact-1')).toBeNull();
    expect(screen.getByTestId('fact-delete-open-fact-1')).toBeTruthy();
  });

  it('calls deleteFact (= retractFact) + onDeleted on submit', async () => {
    const spy = vi.spyOn(api, 'deleteFact').mockResolvedValue({
      fact_uid: 'fact-1',
      retracted_at: new Date('2026-07-01T00:00:00Z'),
      source_uids: [],
      auto_retracted: false,
    });
    const onDeleted = vi.fn();
    render(
      <FactDeleteButton
        spaceId="space-1"
        factUid="fact-1"
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByTestId('fact-delete-open-fact-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('fact-delete-submit-fact-1'));
    });
    expect(spy).toHaveBeenCalledWith('space-1', 'fact-1');
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('surfaces server error, keeps the confirm block visible', async () => {
    vi.spyOn(api, 'deleteFact').mockRejectedValue(new Error('404 gone'));
    render(<FactDeleteButton spaceId="space-1" factUid="fact-1" />);
    fireEvent.click(screen.getByTestId('fact-delete-open-fact-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('fact-delete-submit-fact-1'));
    });
    expect(screen.getByTestId('fact-delete-error-fact-1').textContent)
      .toMatch(/404 gone/);
    expect(screen.getByTestId('fact-delete-confirm-fact-1')).toBeTruthy();
  });
});
