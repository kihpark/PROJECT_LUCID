import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PendingQueueList } from '@/components/PendingQueueList';
import type { PendingPage } from '@/lib/types';

const page: PendingPage = {
  items: [
    {
      job_id: 'job-1',
      source_url: 'https://example.com/one',
      source_type: 'web_article',
      captured_at: new Date('2026-06-01T10:00:00Z').toISOString(),
      captured_from: 'chrome_ext',
      fact_count: 3,
      object_count: 2,
      has_negation: false,
      has_disambiguation: true,
    },
    {
      job_id: 'job-2',
      source_url: 'https://example.com/two',
      source_type: 'highlighted_text',
      captured_at: new Date('2026-05-30T10:00:00Z').toISOString(),
      captured_from: 'chrome_ext',
      fact_count: 1,
      object_count: 1,
      has_negation: true,
      has_disambiguation: false,
    },
  ],
  total: 25,
  offset: 0,
  limit: 20,
};

describe('PendingQueueList', () => {
  it('renders one card per job + a totals line', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    expect(screen.getByText(/1.{1,3}2 of 25/)).toBeInTheDocument();
    expect(screen.getByTestId('pending-card-job-1')).toBeInTheDocument();
    expect(screen.getByTestId('pending-card-job-2')).toBeInTheDocument();
  });

  it('shows negation + disambig indicators only when set', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const negationIndicators = screen.getAllByTitle('negation_flag');
    const disambigIndicators = screen.getAllByTitle('disambiguation_pending');
    expect(negationIndicators).toHaveLength(1);
    expect(disambigIndicators).toHaveLength(1);
  });

  it('Next button calls onPage with offset+limit', () => {
    const onPage = vi.fn();
    render(<PendingQueueList page={page} onPage={onPage} />);
    fireEvent.click(screen.getByText('Next →'));
    expect(onPage).toHaveBeenCalledWith(20);
  });

  it('card href is the resolved dynamic segment, not a literal [jobId]', () => {
    // Regression for Walking-Skeleton Iteration 2 Bug 1 — the
    // object-form href ({ pathname: '/pending/[jobId]', query: { jobId } })
    // does NOT substitute the dynamic segment; Next.js rendered it as
    // `/pending/[jobId]?jobId=<UUID>` and clicks landed on NotFound.
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const link = screen.getByTestId('pending-card-job-1').closest('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/pending/job-1');
    expect(link!.getAttribute('href')).not.toContain('[jobId]');
    expect(link!.getAttribute('href')).not.toContain('?jobId=');
  });
});
