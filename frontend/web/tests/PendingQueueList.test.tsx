import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  PendingQueueList,
  formatRelativeKo,
  formatAbsoluteKo,
} from '@/components/PendingQueueList';
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
      title: '중국 정부, 미국 기업 10곳에 수출통제',
      hostname: 'example.com',
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
      title: '(제목 없음)',
      hostname: 'example.com',
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

  it('shows disambig indicator only when set (negation badge removed per feat/negation-policy-consistency)', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    // feat/negation-policy-consistency: the ⚠ negation chip used to
    // render whenever job.has_negation was true. PO's policy (already
    // enforced on Decide via feat/decide-ux-v3) is that the warning
    // should only fire on an ACTUAL contradiction relation, not on
    // every sentence containing 안 / 없 / 못. Until fact_relations is
    // wired (schema-only today) the chip is fully removed in the queue.
    // job-2 has has_negation=true in the test fixture but no badge
    // should render — that is exactly the consistency check the PO asked for.
    expect(screen.queryByTitle('negation_flag')).toBeNull();
    expect(screen.queryByText(/negation/i)).toBeNull();
    const disambigIndicators = screen.getAllByTitle('disambiguation_pending');
    expect(disambigIndicators).toHaveLength(1);
  });

  it('does NOT render the negation badge even when has_negation=true on every job', () => {
    // feat/negation-policy-consistency regression guard: build a page where
    // EVERY job carries has_negation=true and assert zero badges render.
    // If a future change re-introduces the badge keyed on has_negation,
    // this test will fail noisily.
    const allNegated: PendingPage = {
      ...page,
      items: page.items.map((j) => ({ ...j, has_negation: true })),
    };
    render(<PendingQueueList page={allNegated} onPage={() => {}} />);
    expect(screen.queryAllByTitle('negation_flag')).toHaveLength(0);
    expect(screen.queryByText(/negation/i)).toBeNull();
  });

  it('renders no negation badge when has_negation=false either (sanity)', () => {
    const noneNegated: PendingPage = {
      ...page,
      items: page.items.map((j) => ({ ...j, has_negation: false })),
    };
    render(<PendingQueueList page={noneNegated} onPage={() => {}} />);
    expect(screen.queryByTitle('negation_flag')).toBeNull();
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
describe('PendingQueueList — pending-card-title-date', () => {
  it('renders the article title as the card heading (not the hostname)', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const title = screen.getByTestId('pending-card-title-job-1');
    expect(title).toBeInTheDocument();
    expect(title.tagName.toLowerCase()).toBe('h3');
    expect(title).toHaveTextContent('중국 정부, 미국 기업 10곳에 수출통제');
    // The bug we are fixing: hostname must NOT be inside the <h3>.
    expect(title.textContent).not.toMatch(/example\.com/);
  });

  it('renders the hostname as a secondary sub-label, not as title', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const host = screen.getByTestId('pending-card-hostname-job-1');
    expect(host).toBeInTheDocument();
    expect(host).toHaveTextContent('example.com');
    // Verify the hostname element is NOT the <h3> title.
    expect(host.tagName.toLowerCase()).not.toBe('h3');
  });

  it('renders a relative captured-at label with absolute time in tooltip', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    const captured = screen.getByTestId('pending-card-captured-job-1');
    expect(captured).toBeInTheDocument();
    // Relative formatter should produce a non-empty, non-ISO string.
    expect(captured.textContent ?? '').not.toMatch(/T\d{2}:\d{2}/);
    expect((captured.textContent ?? '').trim()).not.toBe('');
    // Tooltip carries the absolute / locale form for hover confirmation.
    expect(captured.getAttribute('title')).toBeTruthy();
  });

  it('uses the title field even when it is the fallback "(제목 없음)"', () => {
    render(<PendingQueueList page={page} onPage={() => {}} />);
    expect(
      screen.getByTestId('pending-card-title-job-2'),
    ).toHaveTextContent('(제목 없음)');
  });
});

describe('formatRelativeKo', () => {
  const now = new Date('2026-06-23T12:00:00Z');

  it('returns "방금 전" within the first minute', () => {
    const iso = new Date(now.getTime() - 5_000).toISOString();
    expect(formatRelativeKo(iso, now)).toBe('방금 전');
  });

  it('returns "N분 전" within the hour', () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeKo(iso, now)).toBe('5분 전');
  });

  it('returns "N시간 전" within the day', () => {
    const iso = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    expect(formatRelativeKo(iso, now)).toBe('3시간 전');
  });

  it('returns "N일 전" within the week', () => {
    const iso = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    expect(formatRelativeKo(iso, now)).toBe('2일 전');
  });

  it('returns a locale date for timestamps older than a week', () => {
    const iso = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const out = formatRelativeKo(iso, now);
    // Beyond a week we fall through to a locale date, which still must
    // not be the ISO string (PO complaint was unreadable ISO output).
    expect(out).not.toMatch(/T\d{2}:\d{2}/);
    expect(out).not.toBe('');
  });

  it('returns the absolute string for future timestamps (defensive)', () => {
    const iso = new Date(now.getTime() + 60_000).toISOString();
    const out = formatRelativeKo(iso, now);
    expect(out).not.toBe('방금 전');
    expect(out).not.toBe('');
  });

  it('returns "" for an unparseable ISO string', () => {
    expect(formatRelativeKo('not-a-date', now)).toBe('');
  });
});

describe('formatAbsoluteKo', () => {
  it('returns a locale string for a valid ISO timestamp', () => {
    const out = formatAbsoluteKo(new Date('2026-06-01T10:00:00Z').toISOString());
    expect(out).not.toBe('');
    expect(out).not.toMatch(/^2026-06-01T/);
  });

  it('echoes the input when given garbage so the UI never crashes', () => {
    expect(formatAbsoluteKo('not-a-date')).toBe('not-a-date');
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
