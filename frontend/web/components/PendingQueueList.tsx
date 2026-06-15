'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { ActionButton } from './ActionButton';
import type { PendingJobSummary, PendingPage } from '@/lib/types';

/**
 * Extract the host (domain) from a URL string, returning null when the
 * input is not parseable. U-1: surface the host on the card header so
 * the user can identify the source at a glance without parsing the
 * full URL.
 */
function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

interface Props {
  page: PendingPage;
  onPage: (offset: number) => void;
}

function PendingCard({ job }: { job: PendingJobSummary }) {
  return (
    <Link
      href={`/pending/${job.job_id}` as Route}
      className="block rounded-lg border border-border-subtle bg-bg-card p-4 hover:bg-bg-card-hover transition-colors"
      data-testid={`pending-card-${job.job_id}`}
    >
      <header className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium truncate" title={job.source_url}>
          {hostFromUrl(job.source_url) ?? job.source_url}
        </h3>
        <code className="text-xxs text-text-muted font-mono shrink-0 ml-2">
          {job.source_type}
        </code>
      </header>
      <p className="text-xxs text-text-muted font-mono mb-1 truncate" title={job.source_url}>
        {job.source_url}
      </p>
      <p className="text-xxs text-text-muted font-mono mb-3">
        captured {new Date(job.captured_at).toLocaleString()} · from {job.captured_from}
      </p>
      <dl className="flex gap-4 text-xs text-text-secondary">
        <div>
          <dt className="text-text-muted">facts</dt>
          <dd className="font-mono" data-testid="pending-card-facts">{job.fact_count}</dd>
        </div>
        {job.has_negation && (
          <span
            className="text-accent-error text-xxs font-mono self-end"
            title="negation_flag"
          >
            ⚠ negation
          </span>
        )}
        {job.has_disambiguation && (
          <span
            className="text-accent-warm text-xxs font-mono self-end"
            title="disambiguation_pending"
          >
            ⚡ disambig
          </span>
        )}
      </dl>
    </Link>
  );
}

export function PendingQueueList({ page, onPage }: Props) {
  const start = page.offset + 1;
  const end = Math.min(page.offset + page.items.length, page.total);
  const canPrev = page.offset > 0;
  const canNext = page.offset + page.limit < page.total;

  if (page.items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-subtle p-12 text-center">
        <p className="text-text-secondary">No pending jobs match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted font-mono">
        {start}–{end} of {page.total}
      </p>
      {page.items.map((j) => (
        <PendingCard key={j.job_id} job={j} />
      ))}
      <div className="flex justify-between pt-4">
        <ActionButton
          variant="ghost"
          disabled={!canPrev}
          onClick={() => onPage(Math.max(0, page.offset - page.limit))}
        >
          ← Previous
        </ActionButton>
        <ActionButton
          variant="ghost"
          disabled={!canNext}
          onClick={() => onPage(page.offset + page.limit)}
        >
          Next →
        </ActionButton>
      </div>
    </div>
  );
}
