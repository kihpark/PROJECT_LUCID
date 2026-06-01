import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PendingFilters } from '@/components/PendingFilters';

describe('PendingFilters', () => {
  it('emits the applied filters on Apply click', () => {
    const onChange = vi.fn();
    render(
      <PendingFilters value={{ offset: 0, limit: 20 }} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Source type'), {
      target: { value: 'youtube' },
    });
    fireEvent.click(screen.getByLabelText('Has negation'));
    fireEvent.click(screen.getByText('Apply'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: 'youtube',
        has_negation_flag: true,
        offset: 0,
      }),
    );
  });

  it('Reset clears filters but keeps the limit', () => {
    const onChange = vi.fn();
    render(
      <PendingFilters
        value={{ source_type: 'pdf', has_negation_flag: true, offset: 20, limit: 50 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Reset'));
    expect(onChange).toHaveBeenCalledWith({ offset: 0, limit: 50 });
  });
});
