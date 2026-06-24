/**
 * feat/capture-job-tracker — persistent job tracker.
 *
 * The toast in content/toast.ts is volatile: a navigation, a page
 * close, or even Chrome throttling a backgrounded tab is enough to
 * make the user lose track of an in-flight capture. PO complaint:
 * "내 캡처 어디 갔지?" — there was no second source of truth.
 *
 * This module is that second source of truth. The service worker
 * persists every job it has *initiated* (popup capture, context-menu
 * capture) into `chrome.storage.local` so the popup can render a
 * pull-based "이번 세션" list on demand. The badge module reads the
 * same store to display a numeric counter on the extension icon.
 *
 * Storage layout — kept under a NEW key (`lucid_jobs`) so the
 * existing `lucid_state` in lib/storage.ts is untouched. Settings
 * live under `lucid_settings`. Both keys are independent: a wipe of
 * one does not affect the other.
 *
 *   lucid_jobs     -> TrackedJob[]
 *   lucid_settings -> { trackingEnabled: boolean }
 *
 * Invariants (enforced by getJobs/addJob):
 *   - Newest-first ordering by `created_at`.
 *   - At most JOBS_MAX_ENTRIES rows (oldest dropped from the tail).
 *   - Completed/failed entries older than COMPLETED_TTL_MS pruned on
 *     read. In-flight entries are NEVER pruned by TTL — a stuck job
 *     should stay visible to the user, not silently disappear.
 *
 * The chrome.storage.local promise wrappers swallow `lastError` and
 * fall back to safe defaults; storage rejections (rare but observed
 * on quota-pressured installs) must not crash the SW.
 */

export type TrackedJobStatus = 'saving' | 'analyzing' | 'completed' | 'failed';

export interface TrackedJob {
  job_id: string;
  source_url: string;
  title?: string;
  status: TrackedJobStatus;
  created_at: number;  // epoch ms
  completed_at?: number;
  fact_count?: number;
  error_message?: string;
  source_tab_id?: number;
}

export interface TrackerSettings {
  trackingEnabled: boolean;
}

export interface JobCounts {
  inflight: number;  // saving + analyzing
  ready: number;     // completed
  failed: number;
  total: number;
}

export const JOBS_MAX_ENTRIES = 50;
// 14 days — long enough for a weekly review cadence to catch a
// stragglers but short enough that the popup never shows a
// "이번 세션" list from months ago.
export const COMPLETED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const JOBS_KEY = 'lucid_jobs';
const SETTINGS_KEY = 'lucid_settings';

const DEFAULT_SETTINGS: TrackerSettings = { trackingEnabled: true };

// ---------------------------------------------------------------------------
// chrome.storage.local Promise wrappers — chrome.storage.local is
// callback-style and occasionally fires `lastError`. We surface
// rejections as resolved-empty so callers can reason about a
// degraded-but-functional path.
// ---------------------------------------------------------------------------

// MV3 and modern @types/chrome accept both shapes:
//   chrome.storage.local.get(keys, callback)  -> void
//   chrome.storage.local.get(keys)            -> Promise<result>
// We use a microtask race wrapper so a mis-stubbed mock that never
// fires its callback (and returns nothing) resolves to undefined
// instead of hanging the caller forever. The job-tracker contract
// is "fail-soft to empty state" — a hung storage call is the worst
// outcome.
// 50ms — well above any real chrome.storage.local read latency
// (sub-ms in practice) but short enough that a mis-stubbed mock
// in jsdom unblocks before the test runner's 5s timeout.
const STORAGE_FALLBACK_DELAY_MS = 50;

function fallbackAfter<T>(value: T): Promise<T> {
  // Resolve on the next macrotask tick so a real callback always
  // wins the race in production but a never-fires mock unblocks
  // quickly under jsdom.
  return new Promise<T>((resolve) =>
    setTimeout(() => resolve(value), STORAGE_FALLBACK_DELAY_MS),
  );
}

async function storageGet<T>(key: string): Promise<T | undefined> {
  const real = new Promise<T | undefined>((resolve) => {
    try {
      const ret = (chrome.storage.local.get as unknown as (
        keys: string[] | string | Record<string, unknown>,
        cb?: (result: Record<string, unknown>) => void,
      ) => unknown)([key], (result) => {
        if (chrome.runtime?.lastError) {
          console.info('[lucid] job-tracker get failed', chrome.runtime.lastError);
          resolve(undefined);
          return;
        }
        resolve((result?.[key] as T) ?? undefined);
      });
      // Modern Promise-returning get(): chain onto it as well so we
      // honor whichever path the runtime answered on.
      if (
        ret
        && typeof (ret as { then?: unknown }).then === 'function'
      ) {
        (ret as Promise<Record<string, unknown>>).then(
          (result) => resolve((result?.[key] as T) ?? undefined),
          (err) => {
            console.info('[lucid] job-tracker get promise rejected', err);
            resolve(undefined);
          },
        );
      }
    } catch (err) {
      console.info('[lucid] job-tracker get threw', err);
      resolve(undefined);
    }
  });
  return Promise.race([real, fallbackAfter<T | undefined>(undefined)]);
}

async function storageSet(key: string, value: unknown): Promise<void> {
  const real = new Promise<void>((resolve) => {
    try {
      const ret = (chrome.storage.local.set as unknown as (
        items: Record<string, unknown>,
        cb?: () => void,
      ) => unknown)({ [key]: value }, () => {
        if (chrome.runtime?.lastError) {
          console.info('[lucid] job-tracker set failed', chrome.runtime.lastError);
        }
        resolve();
      });
      if (
        ret
        && typeof (ret as { then?: unknown }).then === 'function'
      ) {
        (ret as Promise<void>).then(
          () => resolve(),
          (err) => {
            console.info('[lucid] job-tracker set promise rejected', err);
            resolve();
          },
        );
      }
    } catch (err) {
      console.info('[lucid] job-tracker set threw', err);
      resolve();
    }
  });
  return Promise.race([real, fallbackAfter<void>(undefined)]);
}

// ---------------------------------------------------------------------------
// Pure helpers — no chrome.* references so they're cheap to test.
// ---------------------------------------------------------------------------

function sortNewestFirst(jobs: TrackedJob[]): TrackedJob[] {
  return [...jobs].sort((a, b) => b.created_at - a.created_at);
}

function isPruneableTerminal(j: TrackedJob, now: number): boolean {
  // Only completed / failed entries are eligible for TTL pruning.
  // In-flight (saving/analyzing) jobs stay visible regardless of
  // age — a stuck job is itself a signal worth surfacing.
  if (j.status !== 'completed' && j.status !== 'failed') return false;
  const stamp = j.completed_at ?? j.created_at;
  return now - stamp > COMPLETED_TTL_MS;
}

export function summarizeJobs(jobs: TrackedJob[]): JobCounts {
  let inflight = 0;
  let ready = 0;
  let failed = 0;
  for (const j of jobs) {
    if (j.status === 'saving' || j.status === 'analyzing') inflight++;
    else if (j.status === 'completed') ready++;
    else if (j.status === 'failed') failed++;
  }
  return { inflight, ready, failed, total: jobs.length };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getJobs(): Promise<TrackedJob[]> {
  const raw = (await storageGet<TrackedJob[]>(JOBS_KEY)) ?? [];
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const kept = raw.filter((j) => !isPruneableTerminal(j, now));
  const sorted = sortNewestFirst(kept);
  // Re-persist if we pruned. We don't await — a missed prune isn't a
  // correctness problem, just a stale-storage cost.
  if (kept.length !== raw.length) {
    void storageSet(JOBS_KEY, sorted);
  }
  return sorted;
}

export async function addJob(input: {
  job_id: string;
  source_url: string;
  title?: string;
  source_tab_id?: number;
  status?: TrackedJobStatus;
}): Promise<TrackedJob> {
  const existing = (await storageGet<TrackedJob[]>(JOBS_KEY)) ?? [];
  const list = Array.isArray(existing) ? existing : [];

  // If the same job_id already exists, replace it. This matters when
  // a retry or a stale duplicate message reaches the SW — we want
  // *one* row per job, not two.
  const filtered = list.filter((j) => j.job_id !== input.job_id);

  const job: TrackedJob = {
    job_id: input.job_id,
    source_url: input.source_url,
    title: input.title,
    status: input.status ?? 'saving',
    created_at: Date.now(),
    source_tab_id: input.source_tab_id,
  };

  // Newest-first ordering, then cap to MAX. Slicing AFTER sort so
  // we drop the oldest, never the freshest.
  const merged = sortNewestFirst([job, ...filtered]).slice(0, JOBS_MAX_ENTRIES);
  await storageSet(JOBS_KEY, merged);
  return job;
}

export async function updateJobStatus(
  job_id: string,
  status: TrackedJobStatus,
  extras?: Partial<Pick<TrackedJob, 'fact_count' | 'error_message' | 'title' | 'completed_at'>>,
): Promise<TrackedJob | undefined> {
  const existing = (await storageGet<TrackedJob[]>(JOBS_KEY)) ?? [];
  const list = Array.isArray(existing) ? existing : [];
  const idx = list.findIndex((j) => j.job_id === job_id);
  if (idx < 0) return undefined;

  const prev = list[idx];
  const isTerminal = status === 'completed' || status === 'failed';
  const next: TrackedJob = {
    ...prev,
    status,
    // Stamp completed_at the first time we reach a terminal state.
    // A caller-supplied completed_at wins so tests / replays can
    // pin the value.
    completed_at:
      extras?.completed_at
      ?? (isTerminal ? (prev.completed_at ?? Date.now()) : prev.completed_at),
    ...(extras?.fact_count !== undefined ? { fact_count: extras.fact_count } : {}),
    ...(extras?.error_message !== undefined ? { error_message: extras.error_message } : {}),
    ...(extras?.title !== undefined ? { title: extras.title } : {}),
  };

  const merged = [...list];
  merged[idx] = next;
  await storageSet(JOBS_KEY, sortNewestFirst(merged));
  return next;
}

export async function clearCompleted(): Promise<void> {
  const existing = (await storageGet<TrackedJob[]>(JOBS_KEY)) ?? [];
  const list = Array.isArray(existing) ? existing : [];
  // Keep saving + analyzing — those represent work the user might
  // still want to track. Drop completed + failed.
  const kept = list.filter((j) => j.status === 'saving' || j.status === 'analyzing');
  await storageSet(JOBS_KEY, sortNewestFirst(kept));
}

export async function clearAllJobs(): Promise<void> {
  await storageSet(JOBS_KEY, []);
}

export async function getSettings(): Promise<TrackerSettings> {
  const raw = await storageGet<Partial<TrackerSettings>>(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(raw && typeof raw === 'object' ? raw : {}),
  };
}

export async function setSettings(
  patch: Partial<TrackerSettings>,
): Promise<TrackerSettings> {
  const cur = await getSettings();
  const next: TrackerSettings = { ...cur, ...patch };
  await storageSet(SETTINGS_KEY, next);
  return next;
}

// Exposed for tests — they need to assert against the exact storage key.
export const __test__ = { JOBS_KEY, SETTINGS_KEY };
