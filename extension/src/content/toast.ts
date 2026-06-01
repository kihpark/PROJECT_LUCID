/**
 * In-page toast (Sprint 2A PR-2A-2). Lives in a content script injected
 * by manifest content_scripts on every URL.
 *
 * Lifecycle:
 *   1. Service worker captures the page and dispatches
 *        chrome.tabs.sendMessage(tabId, {type:'show_toast', job_id, status})
 *   2. Toast renders "Saving to Lucid..." immediately
 *   3. Polls chrome.runtime.sendMessage({type:'get_job_status', job_id})
 *      every 1000 ms; SW makes the real HTTP call (no CORS issues).
 *   4. On structured, also calls {type:'get_structured_summary', job_id}
 *      once to learn the fact_count.
 *   5. Terminal states (structured / *_failed) freeze the toast; a
 *      "Review →" link opens the web Pending Queue.
 *   6. Hard timeout: 60 polling attempts (~60 s). After that the toast
 *      shows "Still working — check the Pending Queue".
 *   7. fade-out 5 s after a terminal state lands (or hard timeout).
 *
 * CSS is inlined into a single <style data-lucid-toast="1"> element
 * injected on first render (see ensureStyle()). We mount under a unique
 * class prefix (.lucid-toast-*) + z-index 2147483647 to survive page
 * resets. Inline injection sidesteps the @crxjs/vite-plugin v2 beta
 * bug that leaves the source-tree CSS path in dist/manifest.json.
 *
 * This file imports nothing from @/lib/api directly — every backend
 * call is mediated by the service worker so the host page's CORS
 * policy is irrelevant.
 */

const WEB_BASE = 'http://localhost:3000';
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 60;
const FADE_OUT_MS = 5000;

type Status =
  | 'pending_extract'
  | 'extracting'
  | 'extracted'
  | 'structuring'
  | 'structured'
  | 'extract_failed'
  | 'structure_failed'
  | 'capture_failed';

interface ShowToastMessage {
  type: 'show_toast';
  job_id?: string;
  status: Status;
  error?: string;
}

interface JobStatusBody {
  status: Status;
  error_message?: string | null;
}

interface JobStatusResponse {
  ok: boolean;
  body?: JobStatusBody;
  error?: string;
}

interface SummaryResponse {
  ok: boolean;
  summary?: { fact_count: number; object_count: number; has_disambiguation: boolean };
  error?: string;
}

const STYLE_ID = 'lucid-toast-styles';
const INLINE_CSS = `
.lucid-toast-root {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family:
    'IBM Plex Sans', 'Inter', system-ui, -apple-system, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #e8e8f0;
  background: #16161e;
  border: 1px solid #262633;
  border-radius: 8px;
  padding: 12px 14px;
  min-width: 240px;
  max-width: 360px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  opacity: 1;
  transform: translateY(0);
  transition: opacity 240ms ease, transform 240ms ease;
}
.lucid-toast-root[data-state='hide'] {
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
}
.lucid-toast-status {
  font-weight: 500;
  margin-bottom: 4px;
}
.lucid-toast-detail {
  color: #9999b3;
  font-size: 11px;
  font-family:
    'IBM Plex Mono', 'SF Mono', Monaco, ui-monospace, monospace;
}
.lucid-toast-link {
  color: #7be0e0;
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
}
.lucid-toast-error {
  color: #ef5b5b;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-lucid-toast', '1');
  style.textContent = INLINE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

let rootEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let detailEl: HTMLElement | null = null;
let pollTimer: number | null = null;
let fadeTimer: number | null = null;
let attempts = 0;
let activeJobId: string | undefined;

function ensureRoot(): HTMLElement {
  ensureStyle();
  if (rootEl) return rootEl;
  rootEl = document.createElement('div');
  rootEl.className = 'lucid-toast-root';
  rootEl.dataset.state = 'show';
  rootEl.setAttribute('role', 'status');

  statusEl = document.createElement('div');
  statusEl.className = 'lucid-toast-status';
  rootEl.appendChild(statusEl);

  detailEl = document.createElement('div');
  detailEl.className = 'lucid-toast-detail';
  rootEl.appendChild(detailEl);

  document.documentElement.appendChild(rootEl);
  return rootEl;
}

function setStatusText(text: string, isError = false): void {
  ensureRoot();
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = 'lucid-toast-status' + (isError ? ' lucid-toast-error' : '');
}

function setDetail(node: Node | string | null): void {
  ensureRoot();
  if (!detailEl) return;
  detailEl.innerHTML = '';
  if (node === null) return;
  if (typeof node === 'string') {
    detailEl.textContent = node;
  } else {
    detailEl.appendChild(node);
  }
}

function makeReviewLink(jobId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lucid-toast-link';
  btn.textContent = 'Review →';
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'open_review',
      job_id: jobId,
    }).catch(() => {});
    // Fall-through: also open directly in case the SW message fails.
    window.open(`${WEB_BASE}/pending/${jobId}`, '_blank');
  });
  return btn;
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function scheduleFadeOut(): void {
  if (fadeTimer !== null) window.clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => {
    if (rootEl) rootEl.dataset.state = 'hide';
  }, FADE_OUT_MS);
}

function isTerminal(status: Status): boolean {
  return (
    status === 'structured'
    || status === 'extract_failed'
    || status === 'structure_failed'
    || status === 'capture_failed'
  );
}

function renderInitial(status: Status, jobId: string | undefined, error: string | undefined): void {
  switch (status) {
    case 'pending_extract':
    case 'extracting':
      setStatusText('Saving to Lucid...');
      setDetail(jobId ? `job ${jobId.slice(0, 8)}` : null);
      break;
    case 'extracted':
    case 'structuring':
      setStatusText('Analyzing...');
      setDetail(jobId ? `job ${jobId.slice(0, 8)}` : null);
      break;
    case 'structured':
      setStatusText('Saved to graph');
      if (jobId) {
        setDetail(makeReviewLink(jobId));
      }
      scheduleFadeOut();
      break;
    case 'extract_failed':
    case 'structure_failed':
    case 'capture_failed':
      setStatusText('Save failed', true);
      setDetail(error || 'Retry from the popup.');
      scheduleFadeOut();
      break;
  }
}

async function updateFromStatus(body: JobStatusBody, jobId: string): Promise<void> {
  const status = body.status;
  if (status === 'structured') {
    setStatusText('Saved to graph');
    let factDetail: string | null = null;
    try {
      const summary = (await chrome.runtime.sendMessage({
        type: 'get_structured_summary',
        job_id: jobId,
      })) as SummaryResponse;
      if (summary?.ok && summary.summary) {
        factDetail = `${summary.summary.fact_count} facts found`;
      }
    } catch {
      // ignore — keep generic message
    }
    const wrapper = document.createElement('span');
    if (factDetail) {
      wrapper.textContent = `${factDetail}  `;
    }
    wrapper.appendChild(makeReviewLink(jobId));
    setDetail(wrapper);
    stopPolling();
    scheduleFadeOut();
  } else if (
    status === 'extract_failed'
    || status === 'structure_failed'
  ) {
    setStatusText('Save failed', true);
    setDetail(body.error_message || 'Check the Pending Queue.');
    stopPolling();
    scheduleFadeOut();
  } else {
    renderInitial(status, jobId, undefined);
  }
}

function startPolling(jobId: string): void {
  stopPolling();
  attempts = 0;
  pollTimer = window.setInterval(async () => {
    attempts++;
    if (attempts > POLL_MAX_ATTEMPTS) {
      stopPolling();
      setStatusText('Still working');
      setDetail('Check the Pending Queue for the latest status.');
      scheduleFadeOut();
      return;
    }
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'get_job_status',
        job_id: jobId,
      })) as JobStatusResponse;
      if (resp?.ok && resp.body) {
        await updateFromStatus(resp.body, jobId);
        if (isTerminal(resp.body.status)) stopPolling();
      }
    } catch (err) {
      // swallow transient failures; keep polling until attempts cap.
      console.debug('[lucid] poll failed', err);
    }
  }, POLL_INTERVAL_MS);
}

function onShowToast(msg: ShowToastMessage): void {
  ensureRoot();
  // Cancel any prior fade-out so a new capture replaces the previous toast.
  if (fadeTimer !== null) {
    window.clearTimeout(fadeTimer);
    fadeTimer = null;
  }
  if (rootEl) rootEl.dataset.state = 'show';

  activeJobId = msg.job_id;
  renderInitial(msg.status, msg.job_id, msg.error);

  if (msg.job_id && !isTerminal(msg.status) && msg.status !== 'capture_failed') {
    startPolling(msg.job_id);
  }
}

// Only attach the listener once, even if the content script is re-evaluated.
if (!(window as unknown as { __lucidToastInstalled?: boolean }).__lucidToastInstalled) {
  (window as unknown as { __lucidToastInstalled?: boolean }).__lucidToastInstalled = true;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (
      typeof msg === 'object'
      && msg !== null
      && (msg as { type?: string }).type === 'show_toast'
    ) {
      onShowToast(msg as ShowToastMessage);
      sendResponse({ ok: true });
    }
    return false;
  });
}

// Expose internals for unit tests.
export const __test__ = {
  ensureRoot,
  renderInitial,
  updateFromStatus,
  startPolling,
  stopPolling,
  isTerminal,
  reset(): void {
    stopPolling();
    if (fadeTimer !== null) {
      window.clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    statusEl = null;
    detailEl = null;
    activeJobId = undefined;
    attempts = 0;
    const style = document.getElementById(STYLE_ID);
    if (style?.parentNode) style.parentNode.removeChild(style);
  },
  get rootEl() {
    return rootEl;
  },
  get attempts() {
    return attempts;
  },
  get activeJobId() {
    return activeJobId;
  },
};

export {};
