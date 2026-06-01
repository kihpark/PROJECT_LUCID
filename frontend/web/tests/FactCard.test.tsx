import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FactCard } from '@/components/FactCard';
import type { FactSummary } from '@/lib/types';

const baseFact: FactSummary = {
  fact_uid: 'fn-1',
  claim: 'AI 가 일자리를 대체한다.',
  claim_en: 'AI will replace jobs.',
  type: 'proposition',
  subject_uid: 'obj-1',
  predicate: 'will_replace',
  object_value: 'jobs',
  negation_flag: false,
  negation_scope: null,
};

describe('FactCard', () => {
  it('renders the claim in the chosen language', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={baseFact} lang="en" onChange={onChange} />,
    );
    expect(screen.getByText('AI will replace jobs.')).toBeInTheDocument();
  });

  it('falls back to KR claim when claim_en missing on en lang', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, claim_en: null }}
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByText('AI 가 일자리를 대체한다.')).toBeInTheDocument();
  });

  it('shows a negation warning when negation_flag is true', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'partial' }}
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('negation_flag');
    expect(screen.getByRole('status')).toHaveTextContent('partial');
  });

  it('switches to edit mode and emits an editedClaim onChange', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={baseFact} lang="en" onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Edit'));
    // Clicking Edit emits the initial edit signal.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'edit' }),
    );
  });

  it('emits accept then discard sequence', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('Accept'));
    fireEvent.click(screen.getByText('Discard'));
    expect(onChange).toHaveBeenNthCalledWith(1, { action: 'accept' });
    expect(onChange).toHaveBeenNthCalledWith(2, { action: 'discard' });
  });
});
