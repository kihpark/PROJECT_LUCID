import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MENU_IDS,
  handleContextMenuClick,
  installContextMenus,
} from '@/background/context-menu';

declare const chrome: {
  contextMenus: { create: ReturnType<typeof vi.fn>; removeAll: ReturnType<typeof vi.fn> };
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { sendMessage: ReturnType<typeof vi.fn> };
};

interface CookieDetails { url: string; name: string }

beforeEach(() => {
  chrome.contextMenus.create.mockReset();
  chrome.contextMenus.removeAll.mockReset();
  chrome.contextMenus.removeAll.mockImplementation((cb?: () => void) => cb && cb());
  chrome.cookies.get.mockReset();
  chrome.tabs.sendMessage = vi.fn();
  vi.unstubAllGlobals();
});

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

describe('context-menu click', () => {
  function stubAuth() {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({ value: details.name === 'lucid_jwt' ? 'jwt-xyz' : 'ks-1' } as chrome.cookies.Cookie);
    });
  }

  it('dispatches a web_article capture for the page item', async () => {
    stubAuth();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: 'job-page-1',
        status_url: '/api/jobs/job-page-1',
        status: 'pending_extract',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://example.com/article',
      } as chrome.contextMenus.OnClickData,
      { id: 7, url: 'https://example.com/article' } as chrome.tabs.Tab,
    );

    const call = fetchMock.mock.calls[0]!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body).toEqual(
      expect.objectContaining({
        source_url: 'https://example.com/article',
        source_type: 'web_article',
        captured_from: 'chrome_ext',
      }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'show_toast',
        job_id: 'job-page-1',
        status: 'pending_extract',
      }),
    );
  });

  it('dispatches a highlighted_text capture for the selection item', async () => {
    stubAuth();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: 'job-sel-2',
        status_url: '/api/jobs/job-sel-2',
        status: 'pending_extract',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

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
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ type: 'show_toast', job_id: 'job-sel-2' }),
    );
  });
});
