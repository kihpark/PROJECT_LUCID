import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DisambigCard } from '@/components/DisambigCard';

const candidates = [
  {
    object_uid: 'obj-a',
    name: 'Samsung Electronics',
    object_class: 'organization',
    score: 1.0,
  },
  {
    object_uid: 'obj-b',
    name: 'Samsung Heavy Industries',
    object_class: 'organization',
    score: 1.0,
  },
];

describe('DisambigCard', () => {
  it('renders each candidate row', () => {
    const onChange = vi.fn();
    render(
      <DisambigCard
        candidateId="obj-llm-1"
        candidateName="삼성"
        decisionReason="exact_match_multi"
        candidates={candidates}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Samsung Electronics')).toBeInTheDocument();
    expect(screen.getByText('Samsung Heavy Industries')).toBeInTheDocument();
  });

  it('emits merge_with with merge_target_uid when a candidate is picked', () => {
    const onChange = vi.fn();
    render(
      <DisambigCard
        candidateId="obj-llm-1"
        candidateName="삼성"
        decisionReason="exact_match_multi"
        candidates={candidates}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Samsung Heavy Industries'));
    expect(onChange).toHaveBeenCalledWith({
      action: 'merge_with',
      mergeTargetUid: 'obj-b',
    });
  });

  it('emits create_new when Create new is clicked', () => {
    const onChange = vi.fn();
    render(
      <DisambigCard
        candidateId="obj-llm-1"
        candidateName="삼성"
        decisionReason="exact_match_multi"
        candidates={candidates}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Create new'));
    expect(onChange).toHaveBeenCalledWith({ action: 'create_new' });
  });
});
