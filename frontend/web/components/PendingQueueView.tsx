'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { PendingFilters } from './PendingFilters';
import { PendingQueueList } from './PendingQueueList';
import { listPending, ApiError } from '@/lib/api';
import type { PendingListFilters, PendingPage } from '@/lib/types';

interface Props {
  spaceId: string;
}

export function PendingQueueView({ spaceId }: Props) {
  const [filters, setFilters] = useState<PendingListFilters>({
    offset: 0,
    limit: 20,
  });
  const [page, setPage] = useState<PendingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await listPending(spaceId, filters);
      setPage(p);
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  }, [spaceId, filters]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-light">Pending Queue</h1>
        <Link
          href={{ pathname: '/pending/auto-accepted' } as never}
          className="text-sm text-accent-cool underline hover:text-accent-cool/80"
        >
          Auto-accepted →
        </Link>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-6">
        <PendingFilters
          value={filters}
          onChange={(next) => setFilters(next)}
        />
        <section aria-label="Queue">
          {busy && page === null && (
            <p className="text-text-secondary text-sm">Loading...</p>
          )}
          {error && (
            <p role="alert" className="text-accent-error text-sm">
              {error}
            </p>
          )}
          {page && (
            <PendingQueueList
              page={page}
              onPage={(offset) => setFilters((f) => ({ ...f, offset }))}
            />
          )}
        </section>
      </div>
    </div>
  );
}
