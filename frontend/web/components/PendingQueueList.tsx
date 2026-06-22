'use client';

import { useState, useEffect, useRef } from 'react';
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
  spaceId?: string;
  onDiscard?: (jobId: string) => Promise<void>;
}

interface PendingCardProps {
  job: PendingJobSummary;
  onDiscardRow?: (jobId: string) => void;
}

function PendingCard({ job, onDiscardRow }: PendingCardProps) {
  return (
    <div
      className="relative rounded-lg border border-border-subtle bg-bg-card p-4 hover:bg-bg-card-hover transition-colors"
      data-testid={`pending-card-${job.job_id}`}
    >
      <Link
        href={`/pending/${job.job_id}` as Route}
        className="block"
      >
        <header className="flex items-baseline justify-between mb-2 gap-3">
          <h3 className="text-sm font-medium truncate" title={job.source_url}>
            {hostFromUrl(job.source_url) ?? job.source_url}
          </h3>
          {/*
           * decide-ux-fix #1: source_type badge moves to a top-right
           * vertical cluster shared with the 폐기 button so they no
           * longer overlap. When onDiscardRow is set the badge stays
           * in the header but reserves right padding equal to the
           * button's width via the parent container's pr-16.
           */}
          <code
            data-testid={`pending-card-source-type-${job.job_id}`}
            className={
              'text-xxs text-text-muted font-mono shrink-0 '
              + (onDiscardRow ? 'mr-14' : '')
            }
          >
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
      {onDiscardRow && (
        <button
          type="button"
          data-testid={`discard-row-${job.job_id}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDiscardRow(job.job_id);
          }}
          className="absolute top-3 right-3 text-xxs text-accent-error/70 hover:text-accent-error font-mono border border-accent-error/30 hover:border-accent-error/70 rounded px-1.5 py-0.5 transition-colors"
          aria-label={`폐기 ${job.job_id}`}
        >
          폐기
        </button>
      )}
    </div>
  );
}

export function PendingQueueList({ page, onPage, spaceId: _spaceId, onDiscard }: Props) {
  // Optimistic removal: track hidden job ids + pending-restore items
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [undoItem, setUndoItem] = useState<{ jobId: string; timeoutId: ReturnType<typeof setTimeout> } | null>(null);

  // Reset hidden state when page changes (new data loaded)
  useEffect(() => {
    setHiddenIds(new Set());
  }, [page]);

  const undoItemRef = useRef(undoItem);
  undoItemRef.current = undoItem;

  const handleDiscardRow = (jobId: string) => {
    // Cancel any existing undo timer
    if (undoItemRef.current) {
      clearTimeout(undoItemRef.current.timeoutId);
    }

    // Optimistically hide the row
    setHiddenIds((prev) => new Set([...prev, jobId]));

    // Start 5s timer to call the actual API
    const timeoutId = setTimeout(async () => {
      setUndoItem(null);
      if (onDiscard) {
        try {
          await onDiscard(jobId);
        } catch {
          // On error restore the row
          setHiddenIds((prev) => {
            const next = new Set(prev);
            next.delete(jobId);
            return next;
          });
        }
      }
    }, 5000);

    setUndoItem({ jobId, timeoutId });
  };

  const handleRestore = () => {
    if (undoItem) {
      clearTimeout(undoItem.timeoutId);
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(undoItem.jobId);
        return next;
      });
      setUndoItem(null);
    }
  };

  const visibleItems = page.items.filter((j) => !hiddenIds.has(j.job_id));
  const start = page.offset + 1;
  const end = Math.min(page.offset + page.items.length, page.total);
  const canPrev = page.offset > 0;
  const canNext = page.offset + page.limit < page.total;

  if (visibleItems.length === 0 && page.items.length === 0) {
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
      {visibleItems.map((j) => (
        <PendingCard
          key={j.job_id}
          job={j}
          onDiscardRow={onDiscard ? handleDiscardRow : undefined}
        />
      ))}
      {visibleItems.length === 0 && page.items.length > 0 && (
        <div className="rounded-lg border border-dashed border-border-subtle p-8 text-center">
          <p className="text-text-secondary text-sm">폐기 처리 중...</p>
        </div>
      )}
      {undoItem && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-elevated px-4 py-3 shadow-lg text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="text-text-secondary">항목이 5초 후 폐기됩니다.</span>
          <button
            type="button"
            onClick={handleRestore}
            className="text-accent-cool underline hover:no-underline font-medium"
          >
            복원
          </button>
        </div>
      )}
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
