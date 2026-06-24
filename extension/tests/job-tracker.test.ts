/**
 * feat/capture-job-tracker — persistent job tracker unit tests.
 *
 * Pattern mirrors tests/storage.test.ts: chrome.storage.local.get /
 * set are stubbed per-case via mockImplementation so each test can
 * preload the storage state it cares about. Reads + writes go
 * through the same JOBS_KEY string the production module uses
 * (exposed via __test__).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addJob,
  clearAllJobs,
  clearCompleted,
  getJobs,
  getSettings,
  JOBS_MAX_ENTRIES,
  setSettings,
  summarizeJobs,
  updateJobStatus,
  __test__,
  COMPLETED_TTL_MS,
  type TrackedJob,
  type TrackedJobStatus,
} from '@/background/job-tracker';

declare const chrome: {
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
  runtime: { lastError: chrome.runtime.LastError | undefined };
};

const { JOBS_KEY, SETTINGS_KEY } = __test__;

function fakeStorage(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  chrome.storage.local.get.mockImplementation(
    (keys: string[], cb: (r: Record<string, unknown>) => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of keyList) {
        if (k in state) out[k] = state[k];
      }
      cb(out);
    },
  );
  chrome.storage.local.set.mockImplementation(
    (obj: Record<string, unknown>, cb: () => void) => {
      Object.assign(state, obj);
      cb();
    },
  );
  return state;
}

function makeJob(
  job_id: string,
  status: TrackedJobStatus,
  created_at: number,
  extras: Partial<TrackedJob> = {},
): TrackedJob {
  return {
    job_id,
    source_url: `https://example.com/${job_id}`,
    title: `title-${job_id}`,
    status,
    created_at,
    ...extras,
  };
}

beforeEach(() => {
  chrome.storage.local.get.mockReset();
  chrome.storage.local.set.mockReset();
  chrome.runtime.lastError = undefined;
});

describe('job-tracker — addJob', () => {
  it('persists with status=saving by default', async () => {
    const state = fakeStorage();
    await addJob({ job_id: 'j-1', source_url: 'https://e.com/a' });
    const stored = (state[JOBS_KEY] as TrackedJob[]) ?? [];
    expect(stored.length).toBe(1);
    expect(stored[0].job_id).toBe('j-1');
    expect(stored[0].status).toBe('saving');
    expect(stored[0].source_url).toBe('https://e.com/a');
    expect(typeof stored[0].created_at).toBe('number');
  });

  it('replaces an existing job_id (no duplicates)', async () => {
    const state = fakeStorage({
      [JOBS_KEY]: [makeJob('j-1', 'saving', 1000)],
    });
    await addJob({
      job_id: 'j-1',
      source_url: 'https://e.com/replaced',
      title: 'replaced',
    });
    const stored = state[JOBS_KEY] as TrackedJob[];
    expect(stored.length).toBe(1);
    expect(stored[0].source_url).toBe('https://e.com/replaced');
    expect(stored[0].title).toBe('replaced');
  });

  it('caps the list to JOBS_MAX_ENTRIES (oldest dropped)', async () => {
    const seeds: TrackedJob[] = [];
    for (let i = 0; i < JOBS_MAX_ENTRIES + 5; i++) {
      seeds.push(makeJob(`j-${i}`, 'saving', 1000 + i));
    }
    const state = fakeStorage({ [JOBS_KEY]: seeds });
    await addJob({ job_id: 'j-new', source_url: 'https://e.com/new' });
    const stored = state[JOBS_KEY] as TrackedJob[];
    expect(stored.length).toBe(JOBS_MAX_ENTRIES);
    // newest-first: the freshly-added entry is at the head
    expect(stored[0].job_id).toBe('j-new');
    // and j-0 (oldest seed) was dropped
    expect(stored.find((j) => j.job_id === 'j-0')).toBeUndefined();
  });
});

describe('job-tracker — updateJobStatus', () => {
  it('transitions and stamps completed_at on terminal state', async () => {
    const state = fakeStorage({
      [JOBS_KEY]: [makeJob('j-1', 'saving', 1000)],
    });
    const before = Date.now();
    const updated = await updateJobStatus('j-1', 'completed', {
      fact_count: 7,
    });
    expect(updated?.status).toBe('completed');
    expect(updated?.fact_count).toBe(7);
    expect(updated?.completed_at).toBeGreaterThanOrEqual(before);
    const stored = state[JOBS_KEY] as TrackedJob[];
    expect(stored[0].status).toBe('completed');
    expect(stored[0].fact_count).toBe(7);
  });

  it('is a no-op on an unknown job_id', async () => {
    const seed = [makeJob('j-1', 'saving', 1000)];
    const state = fakeStorage({ [JOBS_KEY]: seed });
    const result = await updateJobStatus('j-missing', 'completed');
    expect(result).toBeUndefined();
    // existing rows untouched
    const stored = state[JOBS_KEY] as TrackedJob[] | undefined;
    if (stored !== undefined) {
      expect(stored.length).toBe(1);
      expect(stored[0].status).toBe('saving');
    }
  });
});

describe('job-tracker — getJobs', () => {
  it('sorts newest first regardless of stored order', async () => {
    fakeStorage({
      [JOBS_KEY]: [
        makeJob('old', 'saving', 1000),
        makeJob('new', 'saving', 9000),
        makeJob('mid', 'saving', 5000),
      ],
    });
    const jobs = await getJobs();
    expect(jobs.map((j) => j.job_id)).toEqual(['new', 'mid', 'old']);
  });

  it('prunes completed/failed entries older than TTL', async () => {
    const now = Date.now();
    const stale = makeJob('stale', 'completed', now - COMPLETED_TTL_MS - 100, {
      completed_at: now - COMPLETED_TTL_MS - 100,
    });
    const fresh = makeJob('fresh', 'completed', now - 1000, {
      completed_at: now - 1000,
    });
    fakeStorage({ [JOBS_KEY]: [stale, fresh] });
    const jobs = await getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].job_id).toBe('fresh');
  });

  it('does NOT prune in-flight entries even when very old', async () => {
    const now = Date.now();
    fakeStorage({
      [JOBS_KEY]: [
        makeJob('ancient-saving', 'saving', now - 100 * 24 * 60 * 60 * 1000),
      ],
    });
    const jobs = await getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].job_id).toBe('ancient-saving');
  });
});

describe('job-tracker — summarizeJobs', () => {
  it('counts inflight / ready / failed buckets', () => {
    const counts = summarizeJobs([
      makeJob('s1', 'saving', 1),
      makeJob('s2', 'analyzing', 1),
      makeJob('s3', 'analyzing', 1),
      makeJob('c1', 'completed', 1),
      makeJob('f1', 'failed', 1),
    ]);
    expect(counts).toEqual({
      inflight: 3,
      ready: 1,
      failed: 1,
      total: 5,
    });
  });
});

describe('job-tracker — clearCompleted', () => {
  it('preserves saving + analyzing, removes completed + failed', async () => {
    const state = fakeStorage({
      [JOBS_KEY]: [
        makeJob('keep-s', 'saving', 1000),
        makeJob('keep-a', 'analyzing', 2000),
        makeJob('drop-c', 'completed', 3000),
        makeJob('drop-f', 'failed', 4000),
      ],
    });
    await clearCompleted();
    const stored = state[JOBS_KEY] as TrackedJob[];
    const ids = stored.map((j) => j.job_id).sort();
    expect(ids).toEqual(['keep-a', 'keep-s']);
  });
});

describe('job-tracker — settings', () => {
  it('defaults trackingEnabled to true when unset', async () => {
    fakeStorage();
    const s = await getSettings();
    expect(s).toEqual({ trackingEnabled: true });
  });

  it('patches and persists settings', async () => {
    const state = fakeStorage();
    const next = await setSettings({ trackingEnabled: false });
    expect(next.trackingEnabled).toBe(false);
    expect(state[SETTINGS_KEY]).toEqual({ trackingEnabled: false });
    // round-trip — getSettings now returns the persisted value
    chrome.storage.local.get.mockReset();
    chrome.storage.local.get.mockImplementation(
      (_keys: string[], cb: (r: Record<string, unknown>) => void) => {
        cb({ [SETTINGS_KEY]: { trackingEnabled: false } });
      },
    );
    const reread = await getSettings();
    expect(reread.trackingEnabled).toBe(false);
  });
});

describe('job-tracker — clearAllJobs', () => {
  it('wipes the entire list', async () => {
    const state = fakeStorage({
      [JOBS_KEY]: [
        makeJob('j1', 'saving', 1000),
        makeJob('j2', 'completed', 2000),
      ],
    });
    await clearAllJobs();
    expect(state[JOBS_KEY]).toEqual([]);
  });
});
