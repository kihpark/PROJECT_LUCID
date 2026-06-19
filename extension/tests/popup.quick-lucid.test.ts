/**
 * B-58 — Quick Lucid popup behaviour tests.
 *
 * Covers the four capabilities the popup exposes:
 *   1. 오늘의 brief block (data + fail-soft fallback).
 *   2. 이 페이지 캡처 button — SW capture message (same shape as the
 *      context-menu page path; we go through the SW boundary so we
 *      do not depend on internal context-menu.ts surface).
 *   3. 빠른 질문 (recall) — chrome.tabs.create with encoded /recall URL.
 *   4. Lucid 홈 — chrome.tabs.create with /home URL.
 *
 * Auth is stubbed via chrome.cookies.get so the popup boots into its
 * logged-in branch on every case.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { create: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  runtime: { sendMessage: ReturnType<typeof vi.fn> };
};

interface CookieDetails {
  url: string;
  name: string;
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

function stubFetchOk(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    }),
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
  chrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));
  vi.spyOn(window, 'close').mockImplementation(() => {});
});

async function flushTwice(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('Quick Lucid popup — brief block', () => {
  it('renders pending count + first 3 recent entries when /api/home/brief returns data', async () => {
    stubLoggedIn();
    stubFetchOk({
      totals: { facts: 12, entities: 8, sources: 4, this_week_validated: 3 },
      pending_validation: 7,
      recent_validated: [
        {
          fact_uid: 'f1',
          claim: 'GPT-4 is a transformer model trained by OpenAI',
          subject_label: 'GPT-4',
          validated_at: '2026-06-19T01:00:00Z',
        },
        {
          fact_uid: 'f2',
          claim: 'Tim Cook serves as the CEO of Apple Inc.',
          subject_label: 'Tim Cook',
          validated_at: '2026-06-19T00:30:00Z',
        },
        {
          fact_uid: 'f3',
          claim: 'CMU is located in Pittsburgh, Pennsylvania',
          subject_label: 'CMU',
          validated_at: '2026-06-19T00:00:00Z',
        },
        {
          fact_uid: 'f4',
          claim: 'beyond limit row',
          subject_label: 'extra',
          validated_at: '2026-06-18T23:00:00Z',
        },
      ],
      top_cluster: null,
      is_empty: false,
    });

    await import('@/popup/popup.ts');
    await flushTwice();

    const pending = document.querySelector('.brief-pending');
    expect(pending?.textContent).toBe('7');

    const items = document.querySelectorAll('.brief-recent li');
    expect(items.length).toBe(3);
    expect(items[0]?.querySelector('.subject')?.textContent).toBe('GPT-4');
    expect(items[0]?.querySelector('.claim')?.textContent).toMatch(/GPT-4 is a transformer/);
    expect(items[1]?.querySelector('.subject')?.textContent).toBe('Tim Cook');
    expect(items[2]?.querySelector('.subject')?.textContent).toBe('CMU');

    expect(document.getElementById('capture-btn')).not.toBeNull();
    expect(document.getElementById('ask-btn')).not.toBeNull();
    expect(document.getElementById('home-btn')).not.toBeNull();
  });

  it('renders the muted fallback when /api/home/brief rejects — other 3 capabilities remain operational', async () => {
    stubLoggedIn();
    stubFetchReject(new Error('CORS blocked'));

    await import('@/popup/popup.ts');
    await flushTwice();

    const fallback = document.querySelector('.brief-fallback');
    expect(fallback?.textContent).toBe('오늘의 brief 를 불러올 수 없습니다');
    expect(document.querySelectorAll('.brief-recent li').length).toBe(0);

    const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
    const askBtn = document.getElementById('ask-btn') as HTMLButtonElement;
    const homeBtn = document.getElementById('home-btn') as HTMLButtonElement;
    expect(captureBtn).not.toBeNull();
    expect(askBtn).not.toBeNull();
    expect(homeBtn).not.toBeNull();
    expect(captureBtn.disabled).toBe(false);
    expect(askBtn.disabled).toBe(false);
    expect(homeBtn.disabled).toBe(false);
  });
});

describe('Quick Lucid popup — capture button', () => {
  it('dispatches the same {type:"capture"} message the context-menu page path uses', async () => {
    stubLoggedIn();
    stubFetchReject();
    chrome.tabs.query.mockReturnValue(
      Promise.resolve([{ url: 'https://example.com/article' }]),
    );
    chrome.runtime.sendMessage.mockReturnValue(
      Promise.resolve({ ok: true, job_id: 'job-abc' }),
    );

    await import('@/popup/popup.ts');
    await flushTwice();

    const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
    captureBtn.click();
    await flushTwice();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'capture',
        source_url: 'https://example.com/article',
        source_type: 'web_article',
      }),
    );
  });
});

describe('Quick Lucid popup — ask button', () => {
  it('opens /recall?q=<encoded> in a new tab when the user submits', async () => {
    stubLoggedIn();
    stubFetchReject();
    chrome.tabs.create.mockImplementation(() => {});

    await import('@/popup/popup.ts');
    await flushTwice();

    const input = document.getElementById('ask-input') as HTMLInputElement;
    input.value = 'GPT-4 출시일 언제?';
    const askBtn = document.getElementById('ask-btn') as HTMLButtonElement;
    askBtn.click();
    await flushTwice();

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const arg = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
    expect(arg.url).toBe(
      `http://localhost:3000/recall?q=${encodeURIComponent('GPT-4 출시일 언제?')}`,
    );
  });

  it('opens /recall?q=<encoded> when Enter is pressed in the input', async () => {
    stubLoggedIn();
    stubFetchReject();
    chrome.tabs.create.mockImplementation(() => {});

    await import('@/popup/popup.ts');
    await flushTwice();

    const input = document.getElementById('ask-input') as HTMLInputElement;
    input.value = 'tim cook role';
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    await flushTwice();

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const arg = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
    expect(arg.url).toBe(
      `http://localhost:3000/recall?q=${encodeURIComponent('tim cook role')}`,
    );
  });

  it('does nothing when the input is empty', async () => {
    stubLoggedIn();
    stubFetchReject();

    await import('@/popup/popup.ts');
    await flushTwice();

    const askBtn = document.getElementById('ask-btn') as HTMLButtonElement;
    askBtn.click();
    await flushTwice();

    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('Quick Lucid popup — home button', () => {
  it('opens /home in a new tab', async () => {
    stubLoggedIn();
    stubFetchReject();
    chrome.tabs.create.mockImplementation(() => {});

    await import('@/popup/popup.ts');
    await flushTwice();

    const homeBtn = document.getElementById('home-btn') as HTMLButtonElement;
    homeBtn.click();
    await flushTwice();

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const arg = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
    expect(arg.url).toBe('http://localhost:3000/home');
  });
});
