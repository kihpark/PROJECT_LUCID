import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MENU_IDS,
  handleContextMenuClick,
  installContextMenus,
  utf8ToBase64,
} from '@/background/context-menu';

declare const chrome: {
  contextMenus: { create: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn> };
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { sendMessage: ReturnType<typeof vi.fn> };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
};

interface CookieDetails { url: string; name: string }

beforeEach(() => {
  chrome.contextMenus.create.mockReset();
  chrome.contextMenus.removeAll.mockReset();
  chrome.contextMenus.removeAll.mockImplementation((cb?: () => void) => cb && cb());
  chrome.cookies.get.mockReset();
  chrome.tabs.sendMessage = vi.fn();
  chrome.scripting.executeScript = vi.fn();
  vi.unstubAllGlobals();
});

function stubAuth() {
  chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
    cb({ value: details.name === 'lucid_jwt' ? 'jwt-xyz' : 'ks-1' } as chrome.cookies.Cookie);
  });
}

function stubCaptureOk(jobId: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      job_id: jobId,
      status_url: `/api/jobs/${jobId}`,
      status: 'pending_extract',
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('context-menu install', () => {
  it('creates three menu items', () => {
    installContextMenus();
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: MENU_IDS.page, contexts: ['page'] }),
    );
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: MENU_IDS.selection, contexts: ['selection'] }),
    );
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: MENU_IDS.image, contexts: ['image'] }),
    );
  });
});

describe('page save — DOM capture (B-01)', () => {
  it('captures document.documentElement.outerHTML and posts it as raw_payload_b64', async () => {
    stubAuth();
    const html = '<html><body><article>Test body</article></body></html>';
    chrome.scripting.executeScript.mockResolvedValue([{ result: html, frameId: 0, documentId: 'x' }]);
    const fetchMock = stubCaptureOk('job-page-1');

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://example.com/article',
      } as chrome.contextMenus.OnClickData,
      { id: 7, url: 'https://example.com/article' } as chrome.tabs.Tab,
    );

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual(
      expect.objectContaining({
        source_url: 'https://example.com/article',
        source_type: 'web_article',
        captured_from: 'chrome_ext',
        raw_payload_b64: utf8ToBase64(html),
      }),
    );
    // round-trip: base64 decodes back to the original HTML
    expect(atob(body.raw_payload_b64)).toBe(
      String.fromCharCode(...new TextEncoder().encode(html)),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'show_toast', job_id: 'job-page-1', status: 'pending_extract' }),
    );
  });

  it('round-trips Korean (CJK) text through utf8ToBase64', () => {
    const ko = '한국 AI 기본법 — 2024년 12월 통과';
    const b64 = utf8ToBase64(ko);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(ko);
  });

  it('rejects chrome:// schemes with a capture_failed toast (no fetch, no scripting)', async () => {
    stubAuth();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'chrome://settings',
      } as chrome.contextMenus.OnClickData,
      { id: 9, url: 'chrome://settings' } as chrome.tabs.Tab,
    );

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        type: 'show_toast',
        status: 'capture_failed',
        error: expect.stringContaining('browser-internal'),
      }),
    );
  });

  it('rejects about:blank with the same browser-internal toast', async () => {
    stubAuth();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'about:blank',
      } as chrome.contextMenus.OnClickData,
      { id: 10, url: 'about:blank' } as chrome.tabs.Tab,
    );

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ status: 'capture_failed' }),
    );
  });

  it('shows a "could not read" toast when executeScript returns no result', async () => {
    stubAuth();
    chrome.scripting.executeScript.mockResolvedValue([{ result: '', frameId: 0, documentId: 'x' }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://example.com/empty',
      } as chrome.contextMenus.OnClickData,
      { id: 11, url: 'https://example.com/empty' } as chrome.tabs.Tab,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        type: 'show_toast',
        status: 'capture_failed',
        error: expect.stringContaining('Could not read'),
      }),
    );
  });

  it('shows a "could not read" toast when executeScript throws', async () => {
    stubAuth();
    chrome.scripting.executeScript.mockRejectedValue(new Error('No tab with id'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://example.com/x',
      } as chrome.contextMenus.OnClickData,
      { id: 12, url: 'https://example.com/x' } as chrome.tabs.Tab,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        status: 'capture_failed',
        error: expect.stringContaining('Could not read'),
      }),
    );
  });

  it('shows a "too large" toast when the page exceeds 5 MB and suggests selection-save', async () => {
    stubAuth();
    // 5 MB + 1 byte of ASCII = 5 MB + 1 in UTF-8 too.
    const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
    chrome.scripting.executeScript.mockResolvedValue([{ result: huge, frameId: 0, documentId: 'x' }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://example.com/big',
      } as chrome.contextMenus.OnClickData,
      { id: 13, url: 'https://example.com/big' } as chrome.tabs.Tab,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      13,
      expect.objectContaining({
        status: 'capture_failed',
        error: expect.stringContaining('too large'),
      }),
    );
    expect(
      (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1].error,
    ).toMatch(/selection-save/);
  });
});

describe('context-menu click — non-page items (regression)', () => {
  it('dispatches a highlighted_text capture for the selection item', async () => {
    stubAuth();
    const fetchMock = stubCaptureOk('job-sel-2');

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.selection,
        pageUrl: 'https://example.com/article',
        selectionText: 'Quoted passage here',
      } as chrome.contextMenus.OnClickData,
      { id: 8, url: 'https://example.com/article' } as chrome.tabs.Tab,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    );
    expect(body.source_type).toBe('highlighted_text');
    expect(body.raw_payload_b64).toBeTruthy();
    // executeScript MUST NOT fire on selection — that's a different code path.
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ type: 'show_toast', job_id: 'job-sel-2' }),
    );
  });

  it('dispatches an image capture for the image item', async () => {
    stubAuth();
    const fetchMock = stubCaptureOk('job-img-3');

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://example.com/cat.png',
        pageUrl: 'https://example.com/album',
      } as chrome.contextMenus.OnClickData,
      { id: 14, url: 'https://example.com/album' } as chrome.tabs.Tab,
    );

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.source_type).toBe('image');
    expect(body.source_url).toBe('https://example.com/cat.png');
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});
