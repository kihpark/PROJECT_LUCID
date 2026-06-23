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
  tabs: {
    sendMessage: ReturnType<typeof vi.fn>;
    captureVisibleTab: ReturnType<typeof vi.fn>;
  };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  notifications: { create: ReturnType<typeof vi.fn> };
  action: {
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  };
  runtime?: { lastError?: { message?: string } | undefined };
};

interface CookieDetails { url: string; name: string }

beforeEach(() => {
  chrome.contextMenus.create.mockReset();
  chrome.contextMenus.removeAll.mockReset();
  chrome.contextMenus.removeAll.mockImplementation((cb?: () => void) => cb && cb());
  chrome.cookies.get.mockReset();
  chrome.tabs.sendMessage = vi.fn();
  chrome.tabs.captureVisibleTab = vi.fn();
  chrome.scripting.executeScript = vi.fn();
  chrome.notifications.create = vi.fn((_opts: unknown, cb?: () => void) => cb && cb());
  chrome.action.setBadgeText = vi.fn((_d: unknown, cb?: () => void) => cb && cb());
  chrome.action.setBadgeBackgroundColor = vi.fn((_d: unknown, cb?: () => void) => cb && cb());
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
  it('creates four menu items including the B-45.5 screenshot item', () => {
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
    // B-45.5: screenshot menu surfaces on page / frame / selection /
    // image / video / link contexts so the user can reach it
    // wherever they're looking.
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MENU_IDS.screenshot,
        contexts: expect.arrayContaining(['page', 'video']),
      }),
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

  // feat/selection-save-backstop: the selection payload MUST include
  // both `selection_text` and `capture_mode='selection'` in
  // client_metadata so the backend bypasses the URL-extractor chain
  // entirely AND the dedup guard allows the retry for a URL whose
  // prior page-save failed.
  it('★ selection payload includes selection_text and capture_mode=selection', async () => {
    stubAuth();
    const fetchMock = stubCaptureOk('job-sel-3');

    const longSelection =
      '대선 후보의 발언 — 첫 번째 문장입니다. 두 번째 문장도 같이 드래그됐고, '
      + '세 번째 문장도 본문의 핵심 주장입니다.';
    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.selection,
        pageUrl: 'https://www.newsis.com/view/NIS-XYZ',
        selectionText: longSelection,
      } as chrome.contextMenus.OnClickData,
      {
        id: 80,
        url: 'https://www.newsis.com/view/NIS-XYZ',
        title: 'PO 기사 헤드라인',
      } as chrome.tabs.Tab,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    );
    expect(body.source_type).toBe('highlighted_text');
    expect(body.client_metadata.capture_mode).toBe('selection');
    expect(body.client_metadata.selection_text).toBe(longSelection);
    expect(body.client_metadata.page_title).toBe('PO 기사 헤드라인');
    // executeScript MUST NOT fire — the rendered DOM is never read
    // on the selection path; the backstop relies on the user's drag,
    // not on the page DOM.
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  // The raw_payload_b64 path stays so existing
  // HighlightedTextExtractor unit tests don't regress. We assert
  // selection_text in client_metadata == decoded raw_payload_b64.
  it('★ selection_text in client_metadata matches the decoded raw_payload_b64', async () => {
    stubAuth();
    const fetchMock = stubCaptureOk('job-sel-4');

    const selection = '본문에서 드래그한 문장이 정확히 같은 바이트로 페이로드와 일치해야 합니다.';
    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.selection,
        pageUrl: 'https://example.com/x',
        selectionText: selection,
      } as chrome.contextMenus.OnClickData,
      { id: 81, url: 'https://example.com/x' } as chrome.tabs.Tab,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    );
    // UTF-8 decode the base64 payload and compare to selection_text.
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(body.raw_payload_b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(selection);
    expect(body.client_metadata.selection_text).toBe(selection);
  });

  // B-45: the image capture now fetches the image bytes first and
  // ships them as `raw_payload_b64` so the backend has the snapshot
  // (not just a URL that may rot) AND so the vision extractor can
  // transcribe it. source_type also corrects from 'image' to the
  // backend enum 'page_image'.
  it('★ fetches image bytes, sends raw_payload_b64 + source_type=page_image', async () => {
    stubAuth();
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
    ]);
    // Two fetches: (1) image bytes from srcUrl, (2) POST /api/capture.
    const captureResponse = {
      ok: true,
      json: async () => ({
        job_id: 'job-img-3',
        status_url: '/api/jobs/job-img-3',
        status: 'pending_extract',
      }),
    };
    const imageResponse = {
      ok: true,
      arrayBuffer: async () => imageBytes.buffer,
    };
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/cat.png') return imageResponse;
      return captureResponse;
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://example.com/cat.png',
        pageUrl: 'https://example.com/album',
      } as chrome.contextMenus.OnClickData,
      { id: 14, url: 'https://example.com/album' } as chrome.tabs.Tab,
    );

    // Two outbound fetches: image, then capture.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://example.com/cat.png');
    const captureBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as { body: string }).body,
    );
    expect(captureBody.source_type).toBe('page_image');
    expect(captureBody.source_url).toBe('https://example.com/cat.png');
    expect(captureBody.raw_payload_b64).toBeTruthy();
    // The base64 payload decodes to the original PNG magic bytes.
    const decoded = Uint8Array.from(
      atob(captureBody.raw_payload_b64), (c) => c.charCodeAt(0),
    );
    expect(Array.from(decoded.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // Originating page URL preserved for the vision extractor metadata.
    expect(captureBody.client_metadata.source_page_url).toBe(
      'https://example.com/album',
    );
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('surfaces a toast error when the image fetch fails AND page-context fetch also fails', async () => {
    stubAuth();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/missing.png') {
        return { ok: false, status: 404 };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    // Page-context fallback also fails — the page can't reach the
    // image either. Forces the honest-failure path.
    chrome.scripting.executeScript.mockResolvedValue([{
      result: { ok: false, error: 'page HTTP 403' },
      frameId: 0, documentId: 'x',
    }]);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://example.com/missing.png',
        pageUrl: 'https://example.com/page',
      } as chrome.contextMenus.OnClickData,
      { id: 21, url: 'https://example.com/page' } as chrome.tabs.Tab,
    );

    // Capture POST was never made — only the SW image fetch happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      21,
      expect.objectContaining({
        type: 'show_toast',
        status: 'capture_failed',
      }),
    );
    // ★ The toast carries an honest reason — NOT "[object Object]".
    const sendCall = chrome.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { status?: string }).status === 'capture_failed',
    );
    const msg = (sendCall![1] as { error: string }).error;
    expect(msg).not.toMatch(/\[object Object\]/);
    expect(msg).toMatch(/직접 저장할 수 없습니다|HTTP 404|page HTTP 403/);
  });

  // B-45-fix: blob: URLs (Threads video frames, IG carousels) cannot
  // be fetched from the SW; the page-context fallback is the only path
  // that works. Cover that explicitly.
  it('★ blob: URL falls back to page-context fetch and succeeds', async () => {
    stubAuth();
    const realPng = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xab, 0xcd,
    ]);
    const b64 = btoa(String.fromCharCode(...realPng));
    chrome.scripting.executeScript.mockResolvedValue([{
      result: { ok: true, b64 },
      frameId: 0, documentId: 'x',
    }]);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      // Capture POST only — the blob: URL never goes through SW fetch.
      if (url === 'http://localhost:8000/api/capture') {
        return {
          ok: true,
          json: async () => ({
            job_id: 'job-blob-1',
            status_url: '/api/jobs/job-blob-1',
            status: 'pending_extract',
          }),
        };
      }
      throw new Error('SW should not fetch the blob: URL directly');
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'blob:https://threads.com/abc-def',
        pageUrl: 'https://threads.com/post/123',
      } as chrome.contextMenus.OnClickData,
      { id: 42, url: 'https://threads.com/post/123' } as chrome.tabs.Tab,
    );

    // executeScript ran in page context for the blob: URL.
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 42 },
        args: ['blob:https://threads.com/abc-def'],
      }),
    );
    const captureCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'http://localhost:8000/api/capture',
    );
    expect(captureCall).toBeTruthy();
    const captureBody = JSON.parse(
      (captureCall![1] as { body: string }).body,
    );
    expect(captureBody.source_type).toBe('page_image');
    // Non-durable blob: URL was swapped for the page URL.
    expect(captureBody.source_url).toBe('https://threads.com/post/123');
    expect(captureBody.client_metadata.image_src_url).toBe(
      'blob:https://threads.com/abc-def',
    );
    const decoded = Uint8Array.from(
      atob(captureBody.raw_payload_b64), (c) => c.charCodeAt(0),
    );
    expect(Array.from(decoded.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: 'show_toast', job_id: 'job-blob-1' }),
    );
  });

  // B-45-fix regression: when a non-Error is thrown (e.g. plain
  // object rejection), the toast must NOT render "undefined" or
  // "[object Object]".
  it('★ non-Error rejection from postCapture renders a real string', async () => {
    stubAuth();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/x.png') {
        return { ok: true, arrayBuffer: async () => imageBytes.buffer };
      }
      // Backend returns a Pydantic 422 array → postCapture throws
      // an Error with a real message string (no [object Object]).
      return {
        ok: false,
        status: 422,
        json: async () => ({
          detail: [{
            type: 'value_error',
            loc: ['body', 'raw_payload_b64'],
            msg: 'Value error, raw_payload_b64_invalid',
          }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://example.com/x.png',
        pageUrl: 'https://example.com/p',
      } as chrome.contextMenus.OnClickData,
      { id: 99, url: 'https://example.com/p' } as chrome.tabs.Tab,
    );
    const sendCall = chrome.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { status?: string }).status === 'capture_failed',
    );
    const msg = (sendCall![1] as { error: string }).error;
    expect(msg).not.toMatch(/\[object Object\]/);
    expect(msg).not.toMatch(/^undefined$/);
    expect(msg).toContain('raw_payload_b64_invalid');
  });
});


describe('toast dispatch fallback (B-45-fix2)', () => {
  // Helper: drive the full image capture path so notifyTab runs.
  async function runImageCapture() {
    stubAuth();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://threads.com/image.png') {
        return { ok: true, arrayBuffer: async () => imageBytes.buffer };
      }
      return {
        ok: true,
        json: async () => ({
          job_id: 'job-fb-1',
          status_url: '/api/jobs/job-fb-1',
          status: 'pending_extract',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://threads.com/image.png',
        pageUrl: 'https://threads.com/post/123',
      } as chrome.contextMenus.OnClickData,
      { id: 99, url: 'https://threads.com/post/123' } as chrome.tabs.Tab,
    );
    return fetchMock;
  }

  it('★ when content script is absent, falls back to chrome.notifications', async () => {
    // Threads etc. blocks content_scripts → sendMessage rejects.
    chrome.tabs.sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    const fetchMock = await runImageCapture();

    // Capture itself succeeded (2 fetches: image + capture POST) —
    // toast delivery NEVER blocks the capture.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const captureCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'http://localhost:8000/api/capture',
    );
    expect(captureCall).toBeTruthy();

    // System notification fired with a readable title + body.
    expect(chrome.notifications.create).toHaveBeenCalled();
    const notifCall = chrome.notifications.create.mock.calls[0]!;
    const opts = notifCall[0] as {
      type: string; iconUrl: string; title: string; message: string;
    };
    expect(opts.type).toBe('basic');
    expect(opts.title).toMatch(/Lucid.*저장.*진행/);
    expect(opts.message).toContain('Pending Queue');
    expect(opts.message).toContain('job-fb-1'.slice(0, 8));
  });

  it('★ badge flashes "✓" on success even when toast and notification both fire', async () => {
    chrome.tabs.sendMessage.mockResolvedValue(undefined); // toast succeeds
    await runImageCapture();
    // Badge gets the success mark — works on every page including
    // CSP-locked ones, so this is the always-on ambient signal.
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith(
      expect.objectContaining({ text: '✓' }),
      expect.any(Function),
    );
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalled();
  });

  it('★ badge flashes "!" on capture_failed', async () => {
    stubAuth();
    // Make image fetch + page-context both fail → outcome=failed.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    chrome.scripting.executeScript.mockResolvedValue([{
      result: { ok: false, error: 'HTTP 403' },
      frameId: 0, documentId: 'x',
    }]);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://example.com/no.png',
        pageUrl: 'https://example.com/p',
      } as chrome.contextMenus.OnClickData,
      { id: 77, url: 'https://example.com/p' } as chrome.tabs.Tab,
    );

    const badgeCalls = chrome.action.setBadgeText.mock.calls;
    const flashedFail = badgeCalls.some(
      (c: unknown[]) => (c[0] as { text?: string }).text === '!',
    );
    expect(flashedFail).toBe(true);
  });

  // B-45.5 screenshot test moved below the toast-fallback block so
  // it shares the chrome shim resets in beforeEach.
  it('capture proceeds even when both notifyTab paths throw', async () => {
    // Worst case: tab message rejects AND notifications.create rejects.
    chrome.tabs.sendMessage.mockRejectedValue(new Error('tab gone'));
    chrome.notifications.create = vi.fn(() => {
      throw new Error('notifications permission denied');
    });

    const fetchMock = await runImageCapture();
    // Capture POST still happened — toast failures cannot roll back
    // a 202.
    const captureCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'http://localhost:8000/api/capture',
    );
    expect(captureCall).toBeTruthy();
  });
});


describe('screenshot capture (B-45.5)', () => {
  // A real 1×1 PNG so the base64 round-trip is exercisable.
  const PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
    + 'DUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

  function stubCaptureVisibleTabOk(dataUrl = PNG_DATA_URL) {
    chrome.tabs.captureVisibleTab.mockImplementation(
      (_windowId: number, _opts: unknown, cb: (dataUrl?: string) => void) => {
        cb(dataUrl);
      },
    );
  }

  it('★ snaps the visible tab and POSTs it as page_image', async () => {
    stubAuth();
    stubCaptureVisibleTabOk();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: 'job-ss-1',
        status_url: '/api/jobs/job-ss-1',
        status: 'pending_extract',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.screenshot,
        pageUrl: 'https://threads.com/post/abc',
      } as chrome.contextMenus.OnClickData,
      {
        id: 55,
        windowId: 9,
        url: 'https://threads.com/post/abc',
      } as chrome.tabs.Tab,
    );

    // captureVisibleTab was called against the active window with PNG.
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ format: 'png' }),
      expect.any(Function),
    );

    // Capture POST landed with the screenshot bytes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    );
    expect(body.source_type).toBe('page_image');
    expect(body.source_url).toBe('https://threads.com/post/abc');
    expect(body.client_metadata.capture_kind).toBe('screenshot');
    // The base64 portion of the data URL is what we shipped.
    expect(body.raw_payload_b64).toBe(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
      + 'DUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    );
    // Decodes back to PNG magic bytes.
    const decoded = Uint8Array.from(
      atob(body.raw_payload_b64), (c) => c.charCodeAt(0),
    );
    expect(Array.from(decoded.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('★ honest failure when captureVisibleTab is denied', async () => {
    stubAuth();
    chrome.tabs.captureVisibleTab.mockImplementation(
      (_w: number, _o: unknown, cb: (dataUrl?: string) => void) => {
        // Simulate Chrome's "no permission" path — undefined result
        // and lastError set.
        (chrome as { runtime?: { lastError?: { message?: string } | undefined } })
          .runtime = { lastError: { message: 'Cannot access chrome://' } };
        cb(undefined);
        (chrome as { runtime?: { lastError?: { message?: string } | undefined } })
          .runtime = { lastError: undefined };
      },
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.screenshot,
        pageUrl: 'chrome://extensions/',
      } as chrome.contextMenus.OnClickData,
      {
        id: 1, windowId: 1, url: 'chrome://extensions/',
      } as chrome.tabs.Tab,
    );

    // No capture POST happened.
    expect(fetchMock).not.toHaveBeenCalled();
    // The user gets an honest reason — not "[object Object]".
    const failCall = chrome.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { status?: string }).status === 'capture_failed',
    );
    expect(failCall).toBeTruthy();
    const errorMsg = (failCall![1] as { error: string }).error;
    expect(errorMsg).toMatch(/캡처할 수 없습니다|chrome:\/\//);
    expect(errorMsg).not.toMatch(/\[object Object\]/);
  });
});

// ---------------------------------------------------------------------------
// pending-card-title-date — the extension must forward `tab.title` so the
// Pending Queue card can render the article headline. Each capture path
// (page-save, selection, image, screenshot) had to be patched
// independently because each builds its own client_metadata block.
// ---------------------------------------------------------------------------
describe('context-menu click — forwards tab.title as client_metadata.page_title', () => {
  it('page-save (web_article) includes page_title when tab.title is present', async () => {
    stubAuth();
    chrome.scripting.executeScript.mockResolvedValue([
      { result: '<html><body><article>x</article></body></html>',
        frameId: 0, documentId: 'x' },
    ]);
    const fetchMock = stubCaptureOk('job-title-1');

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://n.news.naver.com/article/123',
      } as chrome.contextMenus.OnClickData,
      {
        id: 30,
        url: 'https://n.news.naver.com/article/123',
        title: '중국 정부, 미국 기업 10곳에 수출통제',
      } as chrome.tabs.Tab,
    );

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.client_metadata?.page_title).toBe(
      '중국 정부, 미국 기업 10곳에 수출통제',
    );
  });

  it('page-save omits client_metadata entirely when tab.title is blank', async () => {
    stubAuth();
    chrome.scripting.executeScript.mockResolvedValue([
      { result: '<html><body></body></html>', frameId: 0, documentId: 'x' },
    ]);
    const fetchMock = stubCaptureOk('job-title-2');

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.page,
        pageUrl: 'https://example.com/no-title',
      } as chrome.contextMenus.OnClickData,
      { id: 31, url: 'https://example.com/no-title' } as chrome.tabs.Tab,
    );

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    // No tab.title supplied -> no page_title key (don't ship "")
    expect(body.client_metadata).toBeUndefined();
  });

  it('selection (highlighted_text) includes page_title alongside selection_range_*', async () => {
    stubAuth();
    const fetchMock = stubCaptureOk('job-title-3');

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.selection,
        pageUrl: 'https://example.com/article',
        selectionText: 'Quoted passage',
      } as chrome.contextMenus.OnClickData,
      {
        id: 32,
        url: 'https://example.com/article',
        title: 'Example Article — A News Site',
      } as chrome.tabs.Tab,
    );

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.client_metadata.page_title).toBe('Example Article — A News Site');
    // Existing selection metadata must NOT regress.
    expect(body.client_metadata.selection_range_start).toBe('0');
    expect(body.client_metadata.selection_range_end).toBe('14');
  });

  it('image capture includes page_title alongside source_page_url', async () => {
    stubAuth();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/photo.png') {
        return { ok: true, arrayBuffer: async () => imageBytes.buffer };
      }
      return {
        ok: true,
        json: async () => ({
          job_id: 'job-title-4',
          status_url: '/api/jobs/job-title-4',
          status: 'pending_extract',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleContextMenuClick(
      {
        menuItemId: MENU_IDS.image,
        srcUrl: 'https://example.com/photo.png',
        pageUrl: 'https://example.com/album',
      } as chrome.contextMenus.OnClickData,
      {
        id: 33,
        url: 'https://example.com/album',
        title: 'Album: Trip to Seoul',
      } as chrome.tabs.Tab,
    );

    const captureCall = fetchMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'http://localhost:8000/api/capture',
    );
    const body = JSON.parse((captureCall![1] as { body: string }).body);
    expect(body.client_metadata.page_title).toBe('Album: Trip to Seoul');
    // Pre-existing image metadata survives.
    expect(body.client_metadata.source_page_url).toBe('https://example.com/album');
  });
});
