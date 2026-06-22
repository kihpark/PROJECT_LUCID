import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssistantView } from '@/components/AssistantView';
import type { AssistantBriefResponse } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  postAssistantBrief: vi.fn(),
}));

import * as api from '@/lib/api';

const MOCK_GROUNDED_RESPONSE: AssistantBriefResponse = {
  grounded: true,
  verified: [
    {
      fact_uid: 'fn-1',
      subject: 'SpaceX',
      predicate_label: '본사 위치',
      object: 'Hawthorne, CA',
      sources: ['src-1', 'src-2'],
    },
    {
      fact_uid: 'fn-2',
      subject: 'Elon Musk',
      predicate_label: '설립자',
      object: 'SpaceX',
      sources: [],
    },
  ],
  inference: 'SpaceX는 Hawthorne에 본사를 두고 있습니다.',
};

const MOCK_NOT_GROUNDED_RESPONSE: AssistantBriefResponse = {
  grounded: false,
  verified: [],
  inference: '검증된 지식에 이 주제가 없습니다.',
};

const MOCK_EMPTY_RESPONSE: AssistantBriefResponse = {
  grounded: false,
  verified: [],
  inference: '',
};

describe('AssistantView', () => {
  const SPACE_ID = 'ks-test-123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Submit calls api with correct query + space_id
  it('calls postAssistantBrief with correct query and space_id on submit', async () => {
    const mockPost = vi.mocked(api.postAssistantBrief);
    mockPost.mockResolvedValue(MOCK_GROUNDED_RESPONSE);

    render(<AssistantView spaceId={SPACE_ID} />);

    const input = screen.getByTestId('assistant-query-input');
    const button = screen.getByTestId('assistant-submit-button');

    fireEvent.change(input, { target: { value: 'SpaceX 본사는 어디인가요?' } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledOnce();
      expect(mockPost).toHaveBeenCalledWith('SpaceX 본사는 어디인가요?', SPACE_ID);
    });
  });

  // 2. Renders verified[] with "검증됨" label/class
  it('renders verified facts with 검증됨 badge when grounded', async () => {
    vi.mocked(api.postAssistantBrief).mockResolvedValue(MOCK_GROUNDED_RESPONSE);

    render(<AssistantView spaceId={SPACE_ID} />);

    const input = screen.getByTestId('assistant-query-input');
    fireEvent.change(input, { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByTestId('assistant-submit-button'));

    await waitFor(() => {
      const badges = screen.getAllByTestId('verified-badge');
      expect(badges.length).toBe(2);
      badges.forEach((badge) => {
        expect(badge.textContent).toBe('검증됨');
      });
    });

    const cards = screen.getAllByTestId('verified-fact-card');
    expect(cards.length).toBe(2);
  });

  // 3. Renders inference with "미보증" label
  it('renders inference card with 미보증 label', async () => {
    vi.mocked(api.postAssistantBrief).mockResolvedValue(MOCK_GROUNDED_RESPONSE);

    render(<AssistantView spaceId={SPACE_ID} />);

    fireEvent.change(screen.getByTestId('assistant-query-input'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByTestId('assistant-submit-button'));

    await waitFor(() => {
      const inferenceCard = screen.getByTestId('inference-card');
      expect(inferenceCard).toBeDefined();
      const label = screen.getByTestId('inference-label');
      expect(label.textContent).toContain('미보증');
    });
  });

  // 4. grounded=false: shows "검증된 지식에 없습니다" + inference, no verified entries
  it('shows not-grounded message when grounded=false', async () => {
    vi.mocked(api.postAssistantBrief).mockResolvedValue(MOCK_NOT_GROUNDED_RESPONSE);

    render(<AssistantView spaceId={SPACE_ID} />);

    fireEvent.change(screen.getByTestId('assistant-query-input'), {
      target: { value: 'unknown topic' },
    });
    fireEvent.click(screen.getByTestId('assistant-submit-button'));

    await waitFor(() => {
      const notGrounded = screen.getByTestId('not-grounded-message');
      expect(notGrounded).toBeDefined();
      expect(notGrounded.textContent).toContain('검증된 지식에 없습니다');
    });

    // No verified cards
    expect(screen.queryAllByTestId('verified-fact-card')).toHaveLength(0);
  });

  // 5. Empty state: no crash on empty response
  it('does not crash on empty response', async () => {
    vi.mocked(api.postAssistantBrief).mockResolvedValue(MOCK_EMPTY_RESPONSE);

    render(<AssistantView spaceId={SPACE_ID} />);

    fireEvent.change(screen.getByTestId('assistant-query-input'), {
      target: { value: 'anything' },
    });
    fireEvent.click(screen.getByTestId('assistant-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('assistant-result')).toBeDefined();
    });

    // No verified section, no inference card with content
    expect(screen.queryAllByTestId('verified-fact-card')).toHaveLength(0);
  });
});
