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

import {
  getJobStatus,
  getStructuredSummary,
  postCapture,
} from '@/lib/api';
import { writeState } from '@/lib/storage';
import { WEB_BASE } from '@/lib/auth';
import {
  installContextMenus,
  installContextMenuListener,
} from './context-menu';
// feat/capture-job-tracker — persistent job list driving the popup
// tracker pane + numeric badge. The capture handler stamps an
// initial 'saving' row; fireTerminalNotification flips it to
// 'completed' / 'failed'. The badge is recomputed at every
// transition.
import {
  addJob,
  clearCompleted,
  dismissJob,
  getJobs,
  getSettings,
  setSettings,
  updateJobStatus,
  type TrackerSettings,
} from './job-tracker';
import { updateBadge } from './badge';

// feat/capture-complete-toast: cache the most-recent terminal
// notification id per job so the click handler can map the
// activation back to a Pending route. Module-scoped (lives in the
// SW heap) so it survives async sendResponse but resets when the
// SW is torn down — acceptable since stale notifications get
// dismissed by the OS on a similar cadence.
const terminalNotifications = new Map<string, string>();
const PENDING_URL = (jobId: string) => `${WEB_BASE}/pending/${jobId}`;

function makeNotificationId(jobId: string): string {
  return `lucid-terminal-${jobId}`;
}

async function fireTerminalNotification(args: {
  jobId: string;
  status: 'structured' | 'extract_failed' | 'structure_failed';
  factCount: number | null;
}): Promise<void> {
  const notifications = (chrome as { notifications?: unknown }).notifications;
  if (
    !notifications
    || typeof (notifications as { create?: unknown }).create !== 'function'
  ) {
    return; // permission absent — content-script toast is the only feedback
  }
  const id = makeNotificationId(args.jobId);
  const failed = args.status !== 'structured';
  const title = failed ? 'Lucid: 저장 실패' : 'Lucid: 분석 완료';
  let body: string;
  if (failed) {
    body = 'Pending Queue 에서 자세한 내용을 확인하세요.';
  } else if (args.factCount === 0) {
    body = '추출된 사실 없음 — Pending Queue 에서 확인하세요.';
  } else if (args.factCount && args.factCount > 0) {
    body = `${args.factCount}건의 사실이 추출됐어요. 검토하세요.`;
  } else {
    body = 'Pending Queue 에서 결과를 검토하세요.';
  }
  try {
    await new Promise<void>((resolve) => {
      (
        chrome.notifications.create as (
          id: string,
          opts: chrome.notifications.NotificationOptions,
          cb?: () => void,
        ) => void
      )(
        id,
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('public/icons/icon-128.png'),
          title,
          message: body,
          // Re-attention so the user actually notices a backgrounded
          // window producing a completion ping.
          requireInteraction: false,
        } as chrome.notifications.NotificationOptions,
        () => resolve(),
      );
    });
    terminalNotifications.set(id, args.jobId);
  } catch (err) {
    console.info('[lucid] terminal notification failed', err);
  }

  // feat/capture-job-tracker — same event that fires the OS
  // notification also flips the tracker row. We do this AFTER the
  // notification create so a thrown notifications call doesn't
  // swallow the tracker update.
  try {
    if (args.status === 'structured') {
      await updateJobStatus(args.jobId, 'completed', {
        fact_count: args.factCount ?? undefined,
      });
    } else {
      await updateJobStatus(args.jobId, 'failed', {
        error_message: 'extraction failed',
      });
    }
    await updateBadge();
  } catch (err) {
    console.info('[lucid] tracker terminal update failed', err);
  }
}

async function openPendingForJob(jobId: string): Promise<void> {
  const url = PENDING_URL(jobId);
  try {
    // Prefer an already-open Lucid tab so we don't pile up duplicates.
    const tabs = await chrome.tabs.query({});
    const lucidTab = tabs.find(
      (t) => typeof t.url === 'string' && t.url.startsWith(WEB_BASE),
    );
    if (lucidTab?.id !== undefined) {
      await chrome.tabs.update(lucidTab.id, { url, active: true });
      if (lucidTab.windowId !== undefined) {
        try {
          await chrome.windows.update(lucidTab.windowId, { focused: true });
        } catch {
          // ignore — window focus is best-effort
        }
      }
      return;
    }
  } catch (err) {
    console.info('[lucid] tab lookup failed', err);
  }
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    console.info('[lucid] tab create failed', err);
  }
}

if (
  typeof chrome !== 'undefined'
  && (chrome as { notifications?: { onClicked?: { addListener?: unknown } } })
    .notifications?.onClicked?.addListener
) {
  chrome.notifications.onClicked.addListener((notificationId: string) => {
    const jobId = terminalNotifications.get(notificationId);
    if (!jobId) return;
    openPendingForJob(jobId);
    try {
      chrome.notifications.clear(notificationId);
    } catch {
      // ignore
    }
    terminalNotifications.delete(notificationId);
  });
}

interface CaptureMessage {
  type: 'capture';
  source_url: string;
  source_type:
    | 'web_article'
    | 'highlighted_text'
    | 'youtube'
    | 'pdf'
    | 'image';
  // pending-card-title-date: popup pulls `chrome.tabs.query` and
  // forwards the active tab's `title` (the browser's resolved
  // <title>) so the backend can stamp it into extracted_metadata
  // *before* the extractor runs. Optional because older popup
  // builds may not include it; the SW must not crash on absence.
  page_title?: string;
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
  installContextMenus();
  // feat/capture-job-tracker — recover the badge after a browser
  // restart / extension reload. The persisted job list survives the
  // SW teardown but `chrome.action.setBadgeText` does not — without
  // this call the badge would stay empty until the next state
  // transition.
  void updateBadge();
});
installContextMenuListener();
// onStartup fires when the browser launches (not on extension
// install). Some Chrome builds tear down + relaunch the SW between
// onInstalled and the user's first interaction; calling updateBadge
// here covers that gap.
try {
  if (
    typeof chrome !== 'undefined'
    && (chrome as { runtime?: { onStartup?: { addListener?: unknown } } })
      .runtime?.onStartup?.addListener
  ) {
    chrome.runtime.onStartup.addListener(() => {
      void updateBadge();
    });
  }
} catch {
  // ignore — onStartup is best-effort
}

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
          // pending-card-title-date: forward page_title into
          // client_metadata so the backend's web_article extractor
          // can prime ExtractResult.title with it (the extractor
          // already reads metadata.page_title — see
          // extractors/web_article.py:281).
          const clientMetadata: Record<string, string> = {};
          const title = (msg.page_title ?? '').trim();
          if (title) clientMetadata.page_title = title;
          const result = await postCapture({
            source_url: msg.source_url,
            source_type: msg.source_type,
            captured_from: 'chrome_ext',
            ...(Object.keys(clientMetadata).length > 0
              ? { client_metadata: clientMetadata }
              : {}),
          });
          // Cache the job id so the popup can show recent captures.
          const cur = await import('@/lib/storage').then((m) => m.readState());
          const next = [...(cur.capturedJobIds || []), result.job_id].slice(-10);
          await writeState({ capturedJobIds: next });
          // feat/capture-job-tracker — add to the persistent tracker
          // and bump the badge. We use the page_title forwarded by
          // the popup (it queries chrome.tabs.query first) as the
          // human-readable label; falling back to `undefined` lets
          // the popup renderer derive a hostname.
          const trackerTitle = title || undefined;
          await addJob({
            job_id: result.job_id,
            source_url: msg.source_url,
            title: trackerTitle,
            source_tab_id: _sender.tab?.id,
          });
          await updateBadge();
          sendResponse({ ok: true, job_id: result.job_id });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true; // async response
    }

    if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'get_job_status') {
      const m = msg as { type: 'get_job_status'; job_id: string };
      (async () => {
        try {
          const body = await getJobStatus(m.job_id);
          sendResponse({ ok: true, body });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'get_structured_summary') {
      const m = msg as { type: 'get_structured_summary'; job_id: string };
      (async () => {
        try {
          const summary = await getStructuredSummary(m.job_id);
          sendResponse({ ok: true, summary });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // feat/capture-complete-toast: the content-script poller asks
    // the SW to surface a system notification when a terminal status
    // is observed. The SW is the only path that survives a
    // backgrounded / hidden host tab.
    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'announce_terminal'
    ) {
      const m = msg as {
        type: 'announce_terminal';
        job_id: string;
        status: 'structured' | 'extract_failed' | 'structure_failed';
        fact_count: number | null;
      };
      (async () => {
        try {
          await fireTerminalNotification({
            jobId: m.job_id,
            status: m.status,
            factCount: m.fact_count,
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // feat/capture-complete-toast: the in-page toast's 검토하기 link
    // asks the SW to open / focus the Lucid Pending page. Pre-fix the
    // SW had no handler so the message bounced to the catch-all error
    // branch; the toast's fallback window.open still ran but it always
    // opened a brand-new tab, even with an existing Lucid session open.
    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'open_review'
    ) {
      const m = msg as { type: 'open_review'; job_id: string };
      (async () => {
        try {
          await openPendingForJob(m.job_id);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // feat/capture-job-tracker — popup pulls the tracker list +
    // settings on every open and after every mutation. Each handler
    // mirrors the existing get_job_status shape: { ok, ...payload }
    // on success, { ok:false, error } on failure.
    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'list_jobs'
    ) {
      (async () => {
        try {
          const jobs = await getJobs();
          sendResponse({ ok: true, jobs });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'clear_completed'
    ) {
      (async () => {
        try {
          await clearCompleted();
          await updateBadge();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // feat/popup-cleanup-discard-sync (PO #1) — user-driven single-row
    // dismiss. Mirrors clear_completed but targets one job_id; safe for
    // any status (saving / analyzing / completed / failed). Pure
    // storage cleanup; never contacts the backend, never mutates the
    // brief. The popup card list and the brief-derived header count
    // are separate sources of truth — this handler only touches the
    // former.
    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'dismiss_job'
    ) {
      const m = msg as { type: 'dismiss_job'; job_id: string };
      (async () => {
        try {
          await dismissJob(m.job_id);
          await updateBadge();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'get_settings'
    ) {
      (async () => {
        try {
          const settings = await getSettings();
          sendResponse({ ok: true, settings });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'set_settings'
    ) {
      const m = msg as { type: 'set_settings'; patch: Partial<TrackerSettings> };
      (async () => {
        try {
          const settings = await setSettings(m.patch ?? {});
          // Setting changes flip the badge — clear when toggled off,
          // re-render when toggled on. The popup also re-renders
          // from its own onChanged listener.
          await updateBadge();
          sendResponse({ ok: true, settings });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    sendResponse({ ok: false, error: 'unknown_message' });
    return false;
  },
);

export {};
