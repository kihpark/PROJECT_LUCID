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

beforeEach(() => {
  resetDom();
  vi.resetModules();
  vi.unstubAllGlobals();
  chrome.cookies.get.mockReset();
  chrome.tabs.create.mockReset();
  chrome.tabs.query.mockReset();
  chrome.runtime.sendMessage.mockReset();
});

describe('popup', () => {
  it('renders the logged-out state when cookies are missing', async () => {
    chrome.cookies.get.mockImplementation((_d: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => cb(null));
    await import('@/popup/popup.ts');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('button.primary')?.textContent).toMatch(
      /lucid\.app/,
    );
    expect(document.getElementById('root')?.dataset.state).toBe('logged_out');
  });

  it('renders the logged-in state when both cookies are present', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({ value: details.name === 'lucid_jwt' ? 'jwt-xyz' : 'ks-1' } as chrome.cookies.Cookie);
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    await import('@/popup/popup.ts');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('capture-btn')).not.toBeNull();
    expect(document.getElementById('ask-btn')).not.toBeNull();
    expect(document.getElementById('home-btn')).not.toBeNull();
    expect(document.getElementById('root')?.dataset.state).toBe('ready');
    expect(document.getElementById('space-name')?.hidden).toBe(false);
  });

  it('Capture button dispatches a capture message to the SW', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({ value: details.name === 'lucid_jwt' ? 'jwt-xyz' : 'ks-1' } as chrome.cookies.Cookie);
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    chrome.tabs.query.mockReturnValue(
      Promise.resolve([{ url: 'https://example.com/article' }]),
    );
    chrome.runtime.sendMessage.mockReturnValue(
      Promise.resolve({ ok: true, job_id: 'job-001' }),
    );

    await import('@/popup/popup.ts');
    await new Promise((r) => setTimeout(r, 0));

    const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
    captureBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'capture',
        source_url: 'https://example.com/article',
        source_type: 'web_article',
      }),
    );
  });
});
