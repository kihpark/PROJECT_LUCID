/**
 * feat/capture-job-tracker — badge updates derive from job-tracker
 * state (inflight + ready). The badge is teal when there's work
 * worth surfacing, empty when there's nothing or when the user
 * toggled tracking off.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { updateBadge, BADGE_COLOR_ACTIVE } from '@/background/badge';
import { __test__, type TrackedJob } from '@/background/job-tracker';

declare const chrome: {
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
  };
  runtime: { lastError: chrome.runtime.LastError | undefined };
  action: {
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  };
};

const { JOBS_KEY, SETTINGS_KEY } = __test__;

function preload(jobs: TrackedJob[], trackingEnabled = true) {
  chrome.storage.local.get.mockImplementation(
    (keys: string[], cb: (r: Record<string, unknown>) => void) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k === JOBS_KEY) out[k] = jobs;
        else if (k === SETTINGS_KEY) out[k] = { trackingEnabled };
      }
      cb(out);
    },
  );
  chrome.storage.local.set.mockImplementation(
    (_obj: Record<string, unknown>, cb: () => void) => cb(),
  );
}

function makeJob(
  job_id: string,
  status: TrackedJob['status'],
  created_at = Date.now() - 1000,
): TrackedJob {
  // completed/failed jobs need a fresh completed_at too so the TTL
  // prune in getJobs doesn't silently drop them mid-test.
  const j: TrackedJob = {
    job_id,
    source_url: `https://e.com/${job_id}`,
    status,
    created_at,
  };
  if (status === 'completed' || status === 'failed') {
    j.completed_at = created_at;
  }
  return j;
}

beforeEach(() => {
  chrome.storage.local.get.mockReset();
  chrome.storage.local.set.mockReset();
  chrome.action.setBadgeText.mockReset();
  chrome.action.setBadgeBackgroundColor.mockReset();
  chrome.action.setBadgeText.mockImplementation(
    (_d: unknown, cb?: () => void) => cb && cb(),
  );
  chrome.action.setBadgeBackgroundColor.mockImplementation(
    (_d: unknown, cb?: () => void) => cb && cb(),
  );
  chrome.runtime.lastError = undefined;
});

describe('badge — updateBadge', () => {
  it('sets text=N when inflight+ready > 0', async () => {
    preload([
      makeJob('s1', 'saving'),
      makeJob('s2', 'saving'),
      makeJob('c1', 'completed'),
    ]);
    await updateBadge();
    const calls = chrome.action.setBadgeText.mock.calls.map(
      (c: unknown[]) => (c[0] as { text: string }).text,
    );
    // The final call should be the count "3"; intermediate clear
    // calls aren't expected since we go straight to the populated
    // path, but tolerate both shapes.
    expect(calls).toContain('3');
  });

  it('clears the badge when there are no inflight/ready jobs', async () => {
    preload([makeJob('f1', 'failed')]); // failed is excluded
    await updateBadge();
    const calls = chrome.action.setBadgeText.mock.calls.map(
      (c: unknown[]) => (c[0] as { text: string }).text,
    );
    expect(calls).toContain('');
    expect(calls.includes('1')).toBe(false);
  });

  it('clears the badge when trackingEnabled is false (even with jobs)', async () => {
    preload(
      [makeJob('s1', 'saving'), makeJob('c1', 'completed')],
      /* trackingEnabled */ false,
    );
    await updateBadge();
    const calls = chrome.action.setBadgeText.mock.calls.map(
      (c: unknown[]) => (c[0] as { text: string }).text,
    );
    expect(calls).toContain('');
    // and we MUST NOT have written a number — disabled means truly empty
    expect(calls.some((t: string) => /\d/.test(t))).toBe(false);
  });

  it('sets the teal accent color when populated', async () => {
    preload([makeJob('s1', 'saving')]);
    await updateBadge();
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith(
      expect.objectContaining({ color: BADGE_COLOR_ACTIVE }),
      expect.any(Function),
    );
  });

  it('excludes failed jobs from the badge count', async () => {
    preload([
      makeJob('s1', 'saving'),       // inflight
      makeJob('c1', 'completed'),    // ready
      makeJob('f1', 'failed'),       // excluded
      makeJob('f2', 'failed'),       // excluded
    ]);
    await updateBadge();
    const calls = chrome.action.setBadgeText.mock.calls.map(
      (c: unknown[]) => (c[0] as { text: string }).text,
    );
    expect(calls).toContain('2'); // 1 saving + 1 completed, NOT 4
  });
});
