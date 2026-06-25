/**
 * feat/popup-cleanup-discard-sync (PO #3) — PendingQueueView discard
 * notify regression guard.
 *
 * Pre-fix: handleDiscard called discardJob + load() but never fired
 * notifyStateChanged. The AppShell badge listens for that event to
 * refetch /api/home/brief; without it, 검증(N) stayed stale at the old
 * count after the user discarded a job from the queue.
 *
 * Post-fix: handleDiscard awaits discardJob, waits 200ms for the read
 * replica to catch up, fires notifyStateChanged('decision-submitted',
 * { jobId, discarded: true }), then reloads its own list.
 *
 * The PendingQueueList component owns a 5s optimistic-undo timer before
 * the actual discardJob fires. Fake timers + React + async updates make
 * that stack brittle; we keep this test pragmatic: use real timers and
 * wait the full 5s + 200ms + slack via waitFor. The test is allowed up
 * to 10s to absorb the wall-clock delay (5s undo + 200ms guard + slack
 * for jsdom microtasks).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PendingQueueView } from '@/components/PendingQueueView';
import type { PendingPage } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  listPending: vi.fn(async () => ({
    items: [
      {
        job_id: 'job-1', source_url: 'https://e.com/a', source_type: 'web_article',
        captured_at: new Date('2026-06-20T00:00:00Z').toISOString(),
        captured_from: 'chrome_ext', fact_count: 2, object_count: 1,
        has_negation: false, has_disambiguation: false,
        title: 'T1', hostname: 'e.com',
      },
    ],
    total: 1, offset: 0, limit: 20,
  } satisfies PendingPage)),
  discardJob: vi.fn(async () => ({
    accepted_facts: [],
    edited_facts: [],
    discarded_facts: [],
    created_objects: [],
    merged_objects: [],
    skipped_objects: [],
    validation_log_count: 1,
  })),
  ApiError: class ApiError extends Error { detail?: string },
}));

import * as api from '@/lib/api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PendingQueueView — discard fires notifyStateChanged (feat/popup-cleanup-discard-sync)', () => {
  it(
    'notifies with discarded:true after the 5s undo timer + discardJob resolves',
    async () => {
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener('lucid:state-changed', handler);

      try {
        render(<PendingQueueView spaceId="ks-1" />);
        await waitFor(() => expect(api.listPending).toHaveBeenCalled());

        const btn = await screen.findByTestId('discard-row-job-1');
        fireEvent.click(btn);

        // The undo timer is 5s (PendingQueueList.tsx:239) and handleDiscard
        // then waits another 200ms before notifyStateChanged. Allow generous
        // slack for jsdom microtask scheduling.
        await waitFor(
          () => expect(api.discardJob).toHaveBeenCalledWith('ks-1', 'job-1'),
          { timeout: 8000 },
        );
        await waitFor(
          () => {
            const evt = events.find(
              (e) =>
                (e.detail as { reason?: string })?.reason === 'decision-submitted',
            );
            expect(evt).toBeDefined();
            expect(
              (evt!.detail as { payload?: { discarded?: boolean } }).payload?.discarded,
            ).toBe(true);
          },
          { timeout: 2000 },
        );
      } finally {
        window.removeEventListener('lucid:state-changed', handler);
      }
    },
    15000,
  );
});
