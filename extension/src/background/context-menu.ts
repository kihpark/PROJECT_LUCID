/**
 * Right-click "Save to Lucid" context menus.
 *
 * Three items:
 *   page       -> source_type: 'web_article'    (current tab URL)
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

function payloadFor(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): CaptureRequest | null {
  switch (info.menuItemId) {
    case MENU_IDS.page: {
      const url = info.pageUrl ?? tab?.url;
      if (!url) return null;
      return {
        source_url: url,
        source_type: 'web_article',
        captured_from: 'chrome_ext',
      };
    }
    case MENU_IDS.selection: {
      const url = info.pageUrl ?? tab?.url ?? '';
      const selected = info.selectionText?.trim();
      if (!selected) return null;
      return {
        source_url: url,
        source_type: 'highlighted_text',
        captured_from: 'chrome_ext',
        raw_payload_b64: btoa(unescape(encodeURIComponent(selected))),
        client_metadata: {
          selection_range_start: '0',
          selection_range_end: String(selected.length),
        },
      };
    }
    case MENU_IDS.image: {
      const url = info.srcUrl ?? '';
      if (!url) return null;
      return {
        source_url: url,
        source_type: 'image',
        captured_from: 'chrome_ext',
        client_metadata: { source_page_url: info.pageUrl ?? '' },
      };
    }
    default:
      return null;
  }
}

export async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const payload = payloadFor(info, tab);
  if (!payload) return;
  const tabId = tab?.id;
  try {
    const result = await postCapture(payload);
    if (tabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'show_toast',
          job_id: result.job_id,
          status: 'pending_extract',
        });
      } catch (sendErr) {
        // tab may not have the content script (e.g. chrome:// URLs);
        // swallow the error since the capture itself succeeded.
        console.info('[lucid] toast dispatch failed', sendErr);
      }
    }
  } catch (err) {
    if (tabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'show_toast',
          status: 'capture_failed',
          error: (err as Error).message,
        });
      } catch {
        // ignore
      }
    }
  }
}

export function installContextMenuListener(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab);
  });
}
