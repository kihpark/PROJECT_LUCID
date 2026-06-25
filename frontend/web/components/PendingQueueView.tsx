'use client';

import { useEffect, useState, useCallback } from 'react';
import { PendingFilters } from './PendingFilters';
import { PendingQueueList } from './PendingQueueList';
import { listPending, discardJob, ApiError } from '@/lib/api';
import { notifyStateChanged } from '@/lib/sync';
import type { PendingListFilters, PendingPage } from '@/lib/types';

interface Props {
  spaceId: string;
}

type Tab = '대기중' | '자동수락';

export function PendingQueueView({ spaceId }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('대기중');
  const [filters, setFilters] = useState<PendingListFilters>({
    offset: 0,
    limit: 20,
  });
  const [page, setPage] = useState<PendingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (activeTab !== '대기중') return;
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
  }, [spaceId, filters, activeTab]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDiscard = useCallback(async (jobId: string) => {
    await discardJob(spaceId, jobId);
    // feat/popup-cleanup-discard-sync (PO #3): notify AppShell + brief
    // listeners so the 검증(N) badge refetches. Pre-fix the queue-side
    // discard only refreshed its own local list (load()), leaving the
    // brief-derived badge stale at the old value. The 200ms wait is a
    // defensive guard so the brief refetch reads the committed state
    // on databases where the read replica may lag the writer.
    await new Promise(r => setTimeout(r, 200));
    notifyStateChanged('decision-submitted', { jobId, discarded: true });
    load();
  }, [spaceId, load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-light mb-4">Pending Queue</h1>
        <div className="flex border-b border-border-subtle gap-1" role="tablist">
          {(['대기중', '자동수락'] as Tab[]).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={[
                'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === tab
                  ? 'border-accent-cool text-accent-cool'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {tab}
            </button>
          ))}
        </div>
      </header>

      {activeTab === '대기중' && (
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
                spaceId={spaceId}
                onDiscard={handleDiscard}
              />
            )}
          </section>
        </div>
      )}

      {activeTab === '자동수락' && (
        <div className="rounded-lg border border-dashed border-border-subtle p-12 text-center">
          <p className="text-text-secondary">자동 수락된 항목이 여기 표시됩니다.</p>
          <p className="text-xs text-text-muted mt-2">
            Auto-accepted facts are reviewed periodically and don&apos;t require manual validation.
          </p>
        </div>
      )}
    </div>
  );
}