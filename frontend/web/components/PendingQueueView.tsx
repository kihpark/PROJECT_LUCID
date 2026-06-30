'use client';

import { useEffect, useState, useCallback } from 'react';
import { PendingFilters } from './PendingFilters';
import { PendingQueueList } from './PendingQueueList';
import { listPending, discardJob, ApiError } from '@/lib/api';
import { notifyStateChanged, useStateChange } from '@/lib/sync';
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

  // fix/h1-state-sync-autorefresh: when DecideOverlay submits/discards
  // on a /pending/[jobId] page and the user navigates back via the
  // success-panel Link, /pending re-mounts and load() runs naturally.
  // But if the user keeps /pending open in a second tab while
  // submitting in the first, the cross-tab BroadcastChannel needs a
  // listener here too — without it, the second tab's queue stayed
  // stale. Subscribing also covers in-tab submits-while-list-visible
  // (e.g. the future inline-decide flow).
  useStateChange(
    useCallback(
      (e) => {
        // eslint-disable-next-line no-console
        console.debug('[PendingQueueView] sync event — reload', e.reason);
        load();
      },
      [load],
    ),
  );

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
        {/* feat/i18n-ko-display-names-separation (★ PO 2026-06-30) —
          * /pending 라우트 = DECIDE (검증 대기열). 한국어 H1. 내부 컴포넌트 /
          * 라우트는 코드명 유지. */}
        <h1 className="text-2xl font-light mb-4">검증 대기열</h1>
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
              <p className="text-text-secondary text-sm">불러오는 중…</p>
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
            자동 수락된 사실은 주기적으로 재검토되며 즉시 검증이 필요하지 않습니다.
          </p>
        </div>
      )}
    </div>
  );
}