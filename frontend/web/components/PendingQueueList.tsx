'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { ActionButton } from './ActionButton';
import type { PendingJobSummary, PendingPage } from '@/lib/types';

/**
 * Extract the host (domain) from a URL string, returning null when the
 * input is not parseable. Retained as a defensive fallback for the
 * (rare) case where the backend's `hostname` field is somehow empty —
 * the typical render reads `job.hostname` directly.
 */
function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * pending-card-title-date: PO complained that the capture timestamp
 * was rendered as a raw ISO string ("2026-05-30T10:00:00Z toLocaleString")
 * that's hard to scan. Show the relative form prominently ("3시간 전",
 * "어제", "방금 전") and keep the absolute date in a tooltip so power
 * users can hover to confirm. Korean copy because the PO uses
 * Korean-language sources end-to-end.
 */
export function formatRelativeKo(iso: string, now: Date = new Date()): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  const diffSec = (now.getTime() - dt.getTime()) / 1000;
  if (diffSec < 0) {
    // Future timestamps are nonsensical for a capture queue; show the
    // absolute date so we don't mislead the user with "방금 전".
    return dt.toLocaleString('ko-KR');
  }
  if (diffSec < 60) return '방금 전';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}일 전`;
  return dt.toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatAbsoluteKo(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('ko-KR');
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
  // pending-card-title-date: prefer the backend-resolved title /
  // hostname; fall back to URL parsing if (e.g. a stale client cache)
  // the fields aren't present yet. This keeps the card usable across
  // a deploy window where the API may have not yet rolled.
  const displayTitle = job.title || hostFromUrl(job.source_url) || job.source_url;
  const displayHostname = job.hostname || hostFromUrl(job.source_url) || '';
  const absoluteCaptured = formatAbsoluteKo(job.captured_at);
  const relativeCaptured = formatRelativeKo(job.captured_at);
  return (
    <div
      className="relative rounded-lg border border-border-subtle bg-bg-card p-4 hover:bg-bg-card-hover transition-colors"
      data-testid={`pending-card-${job.job_id}`}
    >
      <Link
        href={`/pending/${job.job_id}` as Route}
        className="block"
      >
        <header className="flex items-start justify-between mb-2 gap-3">
          {/*
           * pending-card-title-date: TITLE is now the article headline
           * (`job.title`), promoted to text-base + font-semibold so it
           * dominates the card. The previous render shoved the
           * hostname here as if it were a title — which is why the
           * PO saw "n.news.naver.com" everywhere.
           */}
          <h3
            className="text-base font-semibold text-text-primary leading-snug line-clamp-2 break-words"
            title={job.source_url}
            data-testid={`pending-card-title-${job.job_id}`}
          >
            {displayTitle}
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
        {/*
         * pending-card-title-date: META row. Hostname becomes a
         * sub-label (NOT the title), capture date is given its own
         * span with the absolute timestamp in the tooltip. Order
         * intentionally puts the date right after the hostname so the
         * user's eye lands on "언제 저장했는가" within a single sweep.
         */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-text-muted">
          <span
            className="font-mono truncate max-w-[18rem]"
            title={job.source_url}
            data-testid={`pending-card-hostname-${job.job_id}`}
          >
            {displayHostname}
          </span>
          <span
            data-testid={`pending-card-captured-${job.job_id}`}
            title={absoluteCaptured}
          >
            {relativeCaptured}
          </span>
          <span className="text-text-muted/70">· {job.captured_from}</span>
        </div>
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
