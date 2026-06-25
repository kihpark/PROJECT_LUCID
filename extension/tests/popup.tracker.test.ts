/**
 * feat/capture-job-tracker — popup tracker pane behavior.
 *
 * The popup pulls tracker state from the SW via `list_jobs` and
 * `get_settings` messages. These tests stub chrome.runtime.sendMessage
 * with canned responses and assert that the rendered tracker pane
 * matches.
 *
 * Reuses the resetDom / stubLoggedIn pattern from
 * popup.quick-lucid.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { create: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  runtime: { sendMessage: ReturnType<typeof vi.fn> };
  storage: { onChanged: { addListener: ReturnType<typeof vi.fn> } };
};

interface CookieDetails {
  url: string;
  name: string;
}

interface TrackedJob {
  job_id: string;
  source_url: string;
  title?: string;
  status: 'saving' | 'analyzing' | 'completed' | 'failed';
  created_at: number;
  completed_at?: number;
  fact_count?: number;
  error_message?: string;
}

function resetDom() {
  document.body.innerHTML = `
    <div id="root" data-state="loading">
      <header class="header">
        <h1 class="brand">Quick Lucid</h1>
        <span id="space-name" class="space" hidden></span>
      </header>
      <main id="body">
        <p class="loading">Loading...</p>
      </main>
    </div>
  `;
}

function stubLoggedIn() {
  chrome.cookies.get.mockImplementation(
    (details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({
        value: details.name === 'lucid_jwt' ? 'jwt-xyz' : 'ks-1',
      } as chrome.cookies.Cookie);
    },
  );
}

interface SendMessageStubs {
  jobs?: TrackedJob[];
  trackingEnabled?: boolean;
  briefRejects?: boolean;
}

function stubSendMessage(opts: SendMessageStubs) {
  const jobs = opts.jobs ?? [];
  const trackingEnabled = opts.trackingEnabled ?? true;
  chrome.runtime.sendMessage.mockImplementation(
    (msg: { type?: string }) => {
      if (msg?.type === 'list_jobs') {
        return Promise.resolve({ ok: true, jobs });
      }
      if (msg?.type === 'get_settings') {
        return Promise.resolve({
          ok: true,
          settings: { trackingEnabled },
        });
      }
      if (msg?.type === 'set_settings') {
        return Promise.resolve({ ok: true, settings: { trackingEnabled: false } });
      }
      if (msg?.type === 'clear_completed') {
        return Promise.resolve({ ok: true });
      }
      if (msg?.type === 'capture') {
        return Promise.resolve({ ok: true, job_id: 'job-cap' });
      }
      return Promise.resolve({ ok: false });
    },
  );
}

function stubFetchReject(err: unknown = new Error('network down')) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
}

beforeEach(() => {
  resetDom();
  vi.resetModules();
  vi.unstubAllGlobals();
  chrome.cookies.get.mockReset();
  chrome.tabs.create.mockReset();
  chrome.tabs.query.mockReset();
  chrome.runtime.sendMessage.mockReset();
  chrome.storage.onChanged.addListener.mockReset();
  vi.spyOn(window, 'close').mockImplementation(() => {});
});

async function flushTwice(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function flushManyTimes(): Promise<void> {
  // Tracker render flushes a few microtasks: list_jobs → get_settings
  // → render. Brief block also resolves on the same boot. Cover both.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('popup tracker — empty state', () => {
  it('renders the unified review pane with the empty message when no jobs are tracked', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({ jobs: [] });

    await import('@/popup/popup.ts');
    await flushManyTimes();

    const pane = document.getElementById('review-pane');
    expect(pane).not.toBeNull();
    // feat/quick-lucid-popup-redesign — the per-session "이번 세션"
    // heading is gone; the header now carries the /pending link only.
    expect(pane?.querySelector('.tracker-heading-label')).toBeNull();
    expect(pane?.querySelector('.review-pending-link')).not.toBeNull();
    expect(pane?.querySelector('.tracker-empty')).not.toBeNull();
    expect(pane?.querySelectorAll('.tracker-job').length).toBe(0);
  });
});

describe('popup tracker — active job', () => {
  it('renders a status pill ("분석 중…") for an analyzing job', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        {
          job_id: 'job-1',
          source_url: 'https://example.com/post/1',
          title: 'Korean AI bill 2024 passed',
          status: 'analyzing',
          created_at: Date.now() - 5000,
        },
      ],
    });

    await import('@/popup/popup.ts');
    await flushManyTimes();

    const cards = document.querySelectorAll('.tracker-job');
    expect(cards.length).toBe(1);
    const card = cards[0]!;
    expect(card.querySelector('.tracker-job-title')?.textContent).toMatch(
      /Korean AI bill/,
    );
    const pill = card.querySelector('.tracker-status');
    expect(pill?.className).toMatch(/analyzing/);
    expect(pill?.textContent).toMatch(/분석 중/);
  });
});

describe('popup tracker — completed job', () => {
  it('renders 검토하기 → button that opens /pending/{job_id} on click', async () => {
    stubLoggedIn();
    stubFetchReject();
    chrome.tabs.create.mockImplementation(() => {});
    stubSendMessage({
      jobs: [
        {
          job_id: 'job-done',
          source_url: 'https://example.com/x',
          title: 'Sample completed article',
          status: 'completed',
          created_at: Date.now() - 60_000,
          completed_at: Date.now() - 5000,
          fact_count: 4,
        },
      ],
    });

    await import('@/popup/popup.ts');
    await flushManyTimes();

    const reviewBtn = document.querySelector(
      '.tracker-job .tracker-review-btn',
    ) as HTMLButtonElement | null;
    expect(reviewBtn).not.toBeNull();
    expect(reviewBtn?.textContent).toMatch(/검토하기/);

    reviewBtn!.click();
    await flushTwice();

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const arg = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
    expect(arg.url).toBe('http://localhost:3000/pending/job-done');
  });
});

describe('popup tracker — clear completed', () => {
  it('"완료 항목 정리" sends clear_completed to the SW', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        {
          job_id: 'job-c',
          source_url: 'https://e.com/c',
          status: 'completed',
          created_at: Date.now() - 10_000,
          completed_at: Date.now() - 5000,
          fact_count: 1,
        },
      ],
    });

    await import('@/popup/popup.ts');
    await flushManyTimes();

    const clearBtn = document.querySelector(
      '.tracker-clear-btn',
    ) as HTMLButtonElement | null;
    expect(clearBtn).not.toBeNull();

    clearBtn!.click();
    await flushManyTimes();

    const clearCall = chrome.runtime.sendMessage.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { type?: string })?.type === 'clear_completed',
    );
    expect(clearCall).toBeDefined();
  });
});

describe('popup tracker — toggle off', () => {
  it('hides the tracker pane and sends set_settings when the toggle is cleared', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        {
          job_id: 'job-s',
          source_url: 'https://e.com/s',
          status: 'saving',
          created_at: Date.now(),
        },
      ],
    });

    await import('@/popup/popup.ts');
    await flushManyTimes();

    // Tracker is visible initially.
    expect(document.querySelectorAll('.tracker-job').length).toBe(1);

    const checkbox = document.querySelector(
      '.tracker-toggle input',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);

    // Re-stub sendMessage so subsequent list_jobs/get_settings reflect
    // the toggled-off state; the SW message itself was already sent
    // and we assert against that below.
    chrome.runtime.sendMessage.mockImplementation((msg: { type?: string }) => {
      if (msg?.type === 'set_settings') {
        return Promise.resolve({
          ok: true,
          settings: { trackingEnabled: false },
        });
      }
      if (msg?.type === 'get_settings') {
        return Promise.resolve({
          ok: true,
          settings: { trackingEnabled: false },
        });
      }
      if (msg?.type === 'list_jobs') {
        return Promise.resolve({ ok: true, jobs: [] });
      }
      return Promise.resolve({ ok: false });
    });

    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushManyTimes();

    const setCall = chrome.runtime.sendMessage.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { type?: string })?.type === 'set_settings',
    );
    expect(setCall).toBeDefined();
    expect(setCall?.[0]).toMatchObject({
      type: 'set_settings',
      patch: { trackingEnabled: false },
    });

    // Pane collapsed to the off message; no job cards.
    expect(document.querySelector('.tracker-off')).not.toBeNull();
    expect(document.querySelectorAll('.tracker-job').length).toBe(0);
  });
});

describe('popup tracker — mixed status job cards (counts now expressed by per-card pills)', () => {
  it('renders one card per tracked job with its status pill — heading meta string is gone with the redesign', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        {
          job_id: 'a1',
          source_url: 'https://e.com/a1',
          status: 'analyzing',
          created_at: Date.now() - 1000,
        },
        {
          job_id: 'c1',
          source_url: 'https://e.com/c1',
          status: 'completed',
          created_at: Date.now() - 2000,
          completed_at: Date.now() - 1000,
        },
        {
          job_id: 'c2',
          source_url: 'https://e.com/c2',
          status: 'completed',
          created_at: Date.now() - 3000,
          completed_at: Date.now() - 1000,
        },
      ],
    });

    await import('@/popup/popup.ts');
    await flushManyTimes();

    // The unified pane: one card per job, status pill carries the
    // per-row label — no separate summary string in the header.
    expect(document.querySelectorAll('.tracker-job').length).toBe(3);
    expect(document.querySelector('.tracker-heading-meta')).toBeNull();

    const pills = Array.from(
      document.querySelectorAll('.tracker-status'),
    ).map((p) => (p as HTMLElement).className);
    expect(pills.filter((c) => /analyzing/.test(c)).length).toBe(1);
    expect(pills.filter((c) => /completed/.test(c)).length).toBe(2);
  });
});
