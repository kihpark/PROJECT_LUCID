import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecallView } from '@/components/RecallView';
import type { RecallResponse } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  recall: vi.fn(),
  ApiError: class extends Error {
    status = 0;
    detail: string | undefined;
  },
}));

import * as api from '@/lib/api';

const RECALL_HIT: RecallResponse = {
  signature: 'As far as I know — 그래프에 2개 검증 사실이 있습니다',
  total: 2,
  facts: [
    {
      fact_uid: 'fn-1',
      claim: '한국은행 기준금리는 2024년 12월 기준 3.0%였다.',
      claim_en: null,
      subject_uid: 'obj-bok',
      predicate: 'base_rate',
      object_value: '3.0%',
      source_uids: ['https://example.com/article/1'],
      validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
      validator_id: 'user-x',
      validation_method: 'manual',
      knowledge_space_id: 'ks-1',
      negation_flag: false,
      negation_scope: null,
      score: 0.87,
    },
    {
      fact_uid: 'fn-2',
      claim: 'A2 밀크는 A1 대신 A2 베타카제인을 포함한다.',
      claim_en: null,
      subject_uid: 'obj-a2',
      predicate: 'contains',
      object_value: 'A2-beta-casein',
      source_uids: [],
      validated_at: new Date('2026-05-29T10:00:00Z').toISOString(),
      validator_id: 'user-x',
      validation_method: 'manual',
      knowledge_space_id: 'ks-1',
      negation_flag: false,
      negation_scope: null,
      score: 0.75,
    },
  ],
};

const RECALL_EMPTY: RecallResponse = {
  signature: '검증된 사실이 없습니다',
  facts: [],
  total: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RecallView', () => {
  it('renders the prompt, no signature pre-submit', () => {
    render(<RecallView spaceId="ks-1" />);
    expect(screen.getByLabelText('recall query')).toBeInTheDocument();
    expect(screen.queryByTestId('recall-signature')).toBeNull();
  });

  it('submits the query and renders the signature + Korean fact card', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    render(<RecallView spaceId="ks-1" />);

    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '한국은행 기준금리' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const sig = await screen.findByTestId('recall-signature');
    expect(sig.textContent).toMatch(/2개 검증 사실/);
    expect(sig.textContent).toMatch(/As far as I know/);
    expect(
      await screen.findByText('한국은행 기준금리는 2024년 12월 기준 3.0%였다.'),
    ).toBeInTheDocument();
  });

  it('renders the empty signature when total=0', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_EMPTY);
    render(<RecallView spaceId="ks-1" />);

    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'unknown question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    const sig = await screen.findByTestId('recall-signature');
    expect(sig.textContent).toBe('검증된 사실이 없습니다');
    // and no fact cards
    expect(screen.queryByText(/score/)).toBeNull();
  });

  it('Recall button is disabled when the input is empty', () => {
    render(<RecallView spaceId="ks-1" />);
    const btn = screen.getByRole('button', { name: 'Recall' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
