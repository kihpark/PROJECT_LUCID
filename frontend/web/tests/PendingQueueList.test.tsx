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

  it('does not render the objects count (B-29 U-2)', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const factsDds = screen.getAllByTestId('pending-card-facts');
    expect(factsDds.length).toBe(2);
    expect(screen.queryByText(/^objects$/)).toBeNull();
  });

  it('card href is the resolved dynamic segment, not a literal [jobId]', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const card = screen.getByTestId('pending-card-job-1');
    const link = card.closest('a') ?? card.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/pending/job-1');
    expect(link!.getAttribute('href')).not.toContain('[jobId]');
    expect(link!.getAttribute('href')).not.toContain('?jobId=');
  });
});

describe('PendingQueueList — per-row discard (spo-pending-ux)', () => {
  it('renders a 폐기 button per row when onDiscard prop provided', () => {
    const onDiscard = vi.fn(async () => {});
    render(<PendingQueueList page={page} onPage={() => {}} onDiscard={onDiscard} />);
    expect(screen.getByTestId('discard-row-job-1')).toBeInTheDocument();
    expect(screen.getByTestId('discard-row-job-2')).toBeInTheDocument();
  });

  it('does NOT render 폐기 buttons when onDiscard not provided', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    expect(screen.queryByTestId('discard-row-job-1')).toBeNull();
    expect(screen.queryByTestId('discard-row-job-2')).toBeNull();
  });

  it('clicking 폐기 hides the row immediately (optimistic)', () => {
    const onDiscard = vi.fn(() => new Promise<void>(() => {/* never resolves in test */}));
    render(<PendingQueueList page={page} onPage={() => {}} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByTestId('discard-row-job-1'));
    expect(screen.queryByTestId('pending-card-job-1')).toBeNull();
    expect(screen.getByTestId('pending-card-job-2')).toBeInTheDocument();
  });

  it('shows a 복원 snackbar after clicking 폐기', () => {
    const onDiscard = vi.fn(() => new Promise<void>(() => {}));
    render(<PendingQueueList page={page} onPage={() => {}} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByTestId('discard-row-job-1'));
    expect(screen.getByText('복원')).toBeInTheDocument();
  });

  it('clicking 복원 restores the hidden row', () => {
    const onDiscard = vi.fn(() => new Promise<void>(() => {}));
    render(<PendingQueueList page={page} onPage={() => {}} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByTestId('discard-row-job-1'));
    expect(screen.queryByTestId('pending-card-job-1')).toBeNull();
    fireEvent.click(screen.getByText('복원'));
    expect(screen.getByTestId('pending-card-job-1')).toBeInTheDocument();
  });
});
describe('PendingQueueList — decide-ux-fix #1: badge / discard button no overlap', () => {
  it('renders source_type badge and discard button as distinct elements', () => {
    const onDiscard = vi.fn(async () => {});
    render(<PendingQueueList page={page} onPage={() => {}} onDiscard={onDiscard} />);

    const badge = screen.getByTestId('pending-card-source-type-job-1');
    const button = screen.getByTestId('discard-row-job-1');

    expect(badge).toBeInTheDocument();
    expect(button).toBeInTheDocument();
    expect(badge).not.toBe(button);
    // The badge reserves right-side spacing so the absolute-positioned
    // discard button does not cover it.
    expect(badge.className).toMatch(/mr-/);
  });

  it('badge keeps its baseline mr-14 only when discard button is rendered', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const badge = screen.getByTestId('pending-card-source-type-job-1');
    expect(badge.className).not.toMatch(/mr-14/);
  });
});
