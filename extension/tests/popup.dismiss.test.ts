/**
 * fix/popup-dismiss-clickable — × on a tracker card must:
 *   1. dispatch a `dismiss_job` message to the SW with the job_id,
 *   2. remove the card from the DOM,
 *   3. trigger a tracker re-render (list_jobs called again),
 *   4. emit a console.debug breadcrumb so a PO can verify in DevTools.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface CookieDetails { url: string; name: string; }
interface TrackedJob {
  job_id: string;
  source_url: string;
  title?: string;
  status: 'saving' | 'analyzing' | 'completed' | 'failed';
  created_at: number;
  completed_at?: number;
}

function resetDom() {
  document.body.innerHTML = `
    <div id="root" data-state="loading">
      <header class="header">
        <h1 class="brand">Quick Lucid</h1>
        <span id="space-name" class="space" hidden></span>
      </header>
      <main id="body"><p class="loading">Loading...</p></main>
    </div>
  `;
}

function stubLoggedIn() {
  (globalThis as any).chrome.cookies.get.mockImplementation(
    (details: CookieDetails, cb: (c: any) => void) => {
      cb({ value: details.name === 'lucid_jwt' ? 'jwt-xyz' : 'ks-1' });
    },
  );
}

function stubSendMessage(jobs: TrackedJob[]) {
  (globalThis as any).chrome.runtime.sendMessage.mockImplementation((msg: { type?: string }) => {
    if (msg?.type === 'list_jobs') return Promise.resolve({ ok: true, jobs });
    if (msg?.type === 'get_settings') {
      return Promise.resolve({ ok: true, settings: { trackingEnabled: true } });
    }
    if (msg?.type === 'dismiss_job') return Promise.resolve({ ok: true });
    if (msg?.type === 'force_check_status') return Promise.resolve({ ok: true, server_status: null });
    return Promise.resolve({ ok: false });
  });
}

function stubFetchReject() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
}

async function flushManyTimes() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetDom();
  vi.resetModules();
  vi.unstubAllGlobals();
  const cr = (globalThis as any).chrome;
  cr.cookies.get.mockReset();
  cr.tabs.create.mockReset();
  cr.tabs.query.mockReset();
  cr.runtime.sendMessage.mockReset();
  cr.storage.onChanged.addListener.mockReset();
  vi.spyOn(window, 'close').mockImplementation(() => {});
});

describe('popup dismiss × — fix/popup-dismiss-clickable', () => {
  it('sends dismiss_job to the SW with the job_id when × is clicked', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage([
      { job_id: 'job-x', source_url: 'https://e.com/x', status: 'analyzing', created_at: Date.now() - 1000 },
    ]);

    await import('@/popup/popup.ts');
    await flushManyTimes();

    const btn = document.querySelector('.tracker-dismiss-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    btn!.click();
    await flushManyTimes();

    const cr = (globalThis as any).chrome;
    const dismissCall = cr.runtime.sendMessage.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string })?.type === 'dismiss_job',
    );
    expect(dismissCall).toBeDefined();
    expect(dismissCall?.[0]).toMatchObject({ type: 'dismiss_job', job_id: 'job-x' });
  });

  it('removes the card from the DOM after the SW round-trip', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage([
      { job_id: 'job-y', source_url: 'https://e.com/y', status: 'completed', created_at: Date.now() - 5000, completed_at: Date.now() - 1000 },
    ]);

    await import('@/popup/popup.ts');
    await flushManyTimes();

    expect(document.querySelectorAll('.tracker-job').length).toBe(1);
    const btn = document.querySelector('.tracker-dismiss-btn') as HTMLButtonElement;
    btn.click();
    await flushManyTimes();

    expect(document.querySelector('[data-job-id="job-y"]')).toBeNull();
  });

  it('emits a console.debug breadcrumb so the PO can verify in DevTools', async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage([
      { job_id: 'job-d', source_url: 'https://e.com/d', status: 'analyzing', created_at: Date.now() },
    ]);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await import('@/popup/popup.ts');
    await flushManyTimes();

    const btn = document.querySelector('.tracker-dismiss-btn') as HTMLButtonElement;
    btn.click();
    await flushManyTimes();

    const clickLog = debugSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('[popup] dismiss click'),
    );
    expect(clickLog).toBeDefined();
    expect(clickLog?.[1]).toBe('job-d');
  });
});
