/**
 * Lucid Extension service worker (Manifest V3 background module).
 *
 * Listens for `chrome.runtime.onMessage` from the popup. Two message
 * types are handled in PR-2A-1:
 *   { type: 'capture', source_url, source_type } -> postCapture
 *   { type: 'ping' }                              -> { ok: true }
 *
 * The handler returns `true` synchronously to keep the message channel
 * open for the async `fetch`; the response is delivered via the
 * sendResponse callback per MV3 contract.
 */

import { postCapture } from '@/lib/api';
import { writeState } from '@/lib/storage';

interface CaptureMessage {
  type: 'capture';
  source_url: string;
  source_type:
    | 'web_article'
    | 'highlighted_text'
    | 'youtube'
    | 'pdf'
    | 'image';
}

interface PingMessage {
  type: 'ping';
}

type IncomingMessage = CaptureMessage | PingMessage;

function isCaptureMessage(m: unknown): m is CaptureMessage {
  return (
    typeof m === 'object'
    && m !== null
    && (m as CaptureMessage).type === 'capture'
    && typeof (m as CaptureMessage).source_url === 'string'
    && typeof (m as CaptureMessage).source_type === 'string'
  );
}

chrome.runtime.onInstalled.addListener(() => {
  console.info('[lucid] service worker installed');
});

chrome.runtime.onMessage.addListener(
  (msg: IncomingMessage, _sender, sendResponse) => {
    if (msg?.type === 'ping') {
      sendResponse({ ok: true });
      return false;
    }

    if (isCaptureMessage(msg)) {
      // Async path — keep the channel open until postCapture resolves.
      (async () => {
        try {
          const result = await postCapture({
            source_url: msg.source_url,
            source_type: msg.source_type,
            captured_from: 'chrome_ext',
          });
          // Cache the job id so the popup can show recent captures.
          const cur = await import('@/lib/storage').then((m) => m.readState());
          const next = [...(cur.capturedJobIds || []), result.job_id].slice(-10);
          await writeState({ capturedJobIds: next });
          sendResponse({ ok: true, job_id: result.job_id });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true; // async response
    }

    sendResponse({ ok: false, error: 'unknown_message' });
    return false;
  },
);

export {};
