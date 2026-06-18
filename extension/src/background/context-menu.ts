/**
 * Right-click "Save to Lucid" context menus.
 *
 * Three items:
 *   page       -> source_type: 'web_article'    (rendered DOM captured
 *                                                via chrome.scripting and
 *                                                sent as raw_payload_b64;
 *                                                B-01 / DR-086 — rendered
 *                                                DOM is what the user
 *                                                actually sees, not the
 *                                                un-rendered server-fetched
 *                                                HTTP body)
 *   selection  -> source_type: 'highlighted_text' (raw selected text;
 *                                                  PR-2A-3 adds sentence
 *                                                  prefix/suffix context)
 *   image      -> source_type: 'image'           (image URL only;
 *                                                 inline payload is
 *                                                 PR-2A-3 scope)
 *
 * Wiring contract:
 *   onClick -> postCapture -> chrome.tabs.sendMessage(tabId, {
 *     type: 'show_toast', job_id, status: 'pending_extract'
 *   })
 * Toast lives in the content script (src/content/toast.ts).
 */

import { postCapture, type CaptureRequest } from '@/lib/api';

export const MENU_IDS = {
  page: 'lucid-save-page',
  selection: 'lucid-save-selection',
  image: 'lucid-save-image',
} as const;

// Mirrors backend MAX_PRECOMPRESSION_BYTES
// (backend/api/storage/postgres/compression.py). 5 MB of UTF-8 HTML
// is already past trafilatura's useful range; client-side rejection
// avoids a guaranteed 413 round-trip.
const MAX_PAGE_HTML_BYTES = 5 * 1024 * 1024;

// B-45: cap the raw image bytes shipped over the wire. The backend
// vision extractor resizes anyway, but if the SOURCE image is huge
// (e.g. a 20 MB PNG) the base64 payload would blow past the
// pre-compression cap before reaching the extractor. 5 MB matches
// the HTML limit so the 413 boundary is consistent.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Schemes chrome.scripting can never inject into. Captured here so
// the toast can tell the user WHY instead of firing an opaque error.
const UNCAPTURABLE_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'edge:',
  'brave:',
  'about:',
  'view-source:',
  'devtools:',
  'chrome-search:',
];

function isCapturableUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (UNCAPTURABLE_SCHEMES.some((s) => lower.startsWith(s))) return false;
  if (lower.startsWith('file:')) return false;
  return lower.startsWith('http:') || lower.startsWith('https:');
}

/**
 * UTF-8 -> base64, chunked TextEncoder path. The classic
 * `btoa(unescape(encodeURIComponent(s)))` trick uses a deprecated API
 * and deopts on multi-MB payloads. This variant stays fast at 5 MB
 * and is unicode-safe (Korean / emoji / surrogate pairs).
 */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/**
 * Inject a tiny snippet that returns
 * `document.documentElement.outerHTML`. Rendered DOM captures
 * JS-hydrated SPA content the server-side fetch path (kicked by
 * DR-086) cannot reach. Returns null on any scripting error so the
 * caller can show a "save failed" toast.
 */
export async function captureRenderedHtml(
  tabId: number,
): Promise<string | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement?.outerHTML ?? '',
    });
    const first = results?.[0]?.result;
    if (typeof first !== 'string' || first.length === 0) return null;
    return first;
  } catch (err) {
    console.info('[lucid] page capture failed', err);
    return null;
  }
}

type PagePayloadOutcome =
  | { ok: true; payload: CaptureRequest }
  | { ok: false; error: string };

async function buildPagePayload(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<PagePayloadOutcome | null> {
  const url = info.pageUrl ?? tab?.url;
  if (!url) return null;
  if (!isCapturableUrl(url)) {
    return {
      ok: false,
      error:
        'This page cannot be saved (browser-internal page). '
        + 'Try the selection-save action on a normal web page.',
    };
  }
  const tabId = tab?.id;
  if (tabId === undefined) return null;

  const html = await captureRenderedHtml(tabId);
  if (html === null) {
    return {
      ok: false,
      error:
        'Could not read the page contents. '
        + 'Try refreshing the page and saving again.',
    };
  }

  const byteLength = new Blob([html]).size;
  if (byteLength > MAX_PAGE_HTML_BYTES) {
    const mb = (byteLength / 1024 / 1024).toFixed(1);
    const limit = MAX_PAGE_HTML_BYTES / 1024 / 1024;
    return {
      ok: false,
      error:
        `Page too large to save (${mb} MB; limit ${limit} MB). `
        + 'Try the selection-save action on the part you care about.',
    };
  }

  return {
    ok: true,
    payload: {
      source_url: url,
      source_type: 'web_article',
      captured_from: 'chrome_ext',
      raw_payload_b64: utf8ToBase64(html),
    },
  };
}

function buildSyncPayload(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): CaptureRequest | null {
  if (info.menuItemId === MENU_IDS.selection) {
    const url = info.pageUrl ?? tab?.url ?? '';
    const selected = info.selectionText?.trim();
    if (!selected) return null;
    return {
      source_url: url,
      source_type: 'highlighted_text',
      captured_from: 'chrome_ext',
      raw_payload_b64: utf8ToBase64(selected),
      client_metadata: {
        selection_range_start: '0',
        selection_range_end: String(selected.length),
      },
    };
  }
  return null;
}

/**
 * Base64-encode a Uint8Array without going through
 * `String.fromCharCode(...arr)` which blows the stack on large
 * payloads. Same chunked TextDecoder trick as `utf8ToBase64`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

type ImagePayloadOutcome =
  | { ok: true; payload: CaptureRequest }
  | { ok: false; error: string };

/**
 * B-45 — image capture path.
 *
 * Chrome gives us the image's `srcUrl`; we fetch the bytes inline
 * (the service worker has the host permission for active tabs) and
 * pack them into `raw_payload_b64` so the backend has the actual
 * snapshot, not just a URL that may rot. The bytes get stored on
 * `SourceJob.raw_payload` (B-48 snapshot layer) and forwarded to
 * the vision extractor (B-45 image extractor) which transcribes
 * them into claim text for the existing Structure pipeline.
 */
export async function buildImagePayload(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<ImagePayloadOutcome | null> {
  const srcUrl = info.srcUrl ?? '';
  if (!srcUrl) return null;
  if (!isCapturableUrl(srcUrl)) {
    return {
      ok: false,
      error: 'This image cannot be saved (non-http source).',
    };
  }

  let bytes: Uint8Array;
  try {
    const resp = await fetch(srcUrl, { credentials: 'omit' });
    if (!resp.ok) {
      return {
        ok: false,
        error: `Could not fetch image (HTTP ${resp.status}).`,
      };
    }
    const buf = await resp.arrayBuffer();
    bytes = new Uint8Array(buf);
  } catch (err) {
    return {
      ok: false,
      error:
        'Could not fetch the image. '
        + (err instanceof Error ? err.message : 'unknown error'),
    };
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    const limit = MAX_IMAGE_BYTES / 1024 / 1024;
    return {
      ok: false,
      error:
        `Image too large to save (${mb} MB; limit ${limit} MB). `
        + 'Save a smaller version of the image and try again.',
    };
  }

  return {
    ok: true,
    payload: {
      source_url: srcUrl,
      source_type: 'page_image',
      captured_from: 'chrome_ext',
      raw_payload_b64: bytesToBase64(bytes),
      client_metadata: {
        source_page_url: info.pageUrl ?? tab?.url ?? '',
        image_byte_count: String(bytes.byteLength),
      },
    },
  };
}

export function installContextMenus(): void {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_IDS.page,
        title: 'Save page to Lucid',
        contexts: ['page'],
      });
      chrome.contextMenus.create({
        id: MENU_IDS.selection,
        title: 'Save selection to Lucid',
        contexts: ['selection'],
      });
      chrome.contextMenus.create({
        id: MENU_IDS.image,
        title: 'Save image to Lucid',
        contexts: ['image'],
      });
    });
  } catch (err) {
    console.warn('[lucid] context menu install failed', err);
  }
}

async function notifyTab(
  tabId: number | undefined,
  message: Record<string, unknown>,
): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // chrome:// tabs / closed tabs / tabs without the content script
    // can't receive messages. The capture itself may already have
    // landed; the SW log is enough.
    console.info('[lucid] toast dispatch failed', err);
  }
}

export async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const tabId = tab?.id;
  let payload: CaptureRequest | null = null;

  if (info.menuItemId === MENU_IDS.page) {
    const outcome = await buildPagePayload(info, tab);
    if (outcome === null) return;
    if (!outcome.ok) {
      await notifyTab(tabId, {
        type: 'show_toast',
        status: 'capture_failed',
        error: outcome.error,
      });
      return;
    }
    payload = outcome.payload;
  } else if (info.menuItemId === MENU_IDS.image) {
    // B-45: image fetch is async (we have to pull the bytes off the
    // remote host) so it can't share buildSyncPayload's pure path.
    const outcome = await buildImagePayload(info, tab);
    if (outcome === null) return;
    if (!outcome.ok) {
      await notifyTab(tabId, {
        type: 'show_toast',
        status: 'capture_failed',
        error: outcome.error,
      });
      return;
    }
    payload = outcome.payload;
  } else {
    payload = buildSyncPayload(info, tab);
  }

  if (!payload) return;

  try {
    const result = await postCapture(payload);
    await notifyTab(tabId, {
      type: 'show_toast',
      job_id: result.job_id,
      status: 'pending_extract',
    });
  } catch (err) {
    await notifyTab(tabId, {
      type: 'show_toast',
      status: 'capture_failed',
      error: (err as Error).message,
    });
  }
}

export function installContextMenuListener(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab);
  });
}
