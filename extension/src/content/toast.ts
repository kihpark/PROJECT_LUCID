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
// feat/capture-complete-toast: extend the polling window so slow
// structure-stage runs (multi-object Korean articles can take 60–120 s
// when entity resolution fans out per object) still resolve to "분석
// 완료" instead of "처리 지연". Step-down schedule: fast for the
// median path, then slow tail polling out to ~3 min total. The
// "처리 지연" fallback still fires after the full window — it's just
// a true-stuck signal now rather than a Claude-API-latency artifact.
const POLL_INTERVAL_FAST_MS = 1000;
const POLL_INTERVAL_SLOW_MS = 3000;
const POLL_FAST_ATTEMPTS = 30; // 30 s of fast polling
const POLL_MAX_ATTEMPTS = 80;  // + 50 × 3 s = 150 s; total ~180 s
const FADE_OUT_MS = 12000;

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
  btn.textContent = '검토하기 →';
  btn.addEventListener('click', async () => {
    // feat/capture-complete-toast: prefer the SW route (focuses the
    // existing Lucid tab instead of piling up new ones); only fall
    // back to window.open if the SW route reports failure or is
    // unreachable. Pre-fix BOTH routes ran every click which spawned
    // duplicate /pending tabs.
    let opened = false;
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'open_review',
        job_id: jobId,
      })) as { ok?: boolean } | undefined;
      opened = !!resp?.ok;
    } catch {
      opened = false;
    }
    if (!opened) {
      window.open(`${WEB_BASE}/pending/${jobId}`, '_blank');
    }
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
      setStatusText('Lucid 에 저장 중…');
      setDetail(jobId ? `job ${jobId.slice(0, 8)}` : null);
      break;
    case 'extracted':
    case 'structuring':
      setStatusText('분석 중…');
      setDetail(jobId ? `job ${jobId.slice(0, 8)}` : null);
      break;
    case 'structured':
      setStatusText('분석 완료');
      if (jobId) {
        setDetail(makeReviewLink(jobId));
      }
      scheduleFadeOut();
      break;
    case 'extract_failed':
    case 'structure_failed':
    case 'capture_failed':
      setStatusText('저장 실패', true);
      setDetail(error || '팝업에서 다시 시도하세요.');
      scheduleFadeOut();
      break;
  }
}

async function updateFromStatus(body: JobStatusBody, jobId: string): Promise<void> {
  const status = body.status;
  if (status === 'structured') {
    setStatusText('분석 완료');
    let factCount: number | null = null;
    try {
      const summary = (await chrome.runtime.sendMessage({
        type: 'get_structured_summary',
        job_id: jobId,
      })) as SummaryResponse;
      if (summary?.ok && summary.summary) {
        factCount = summary.summary.fact_count;
      }
    } catch {
      // ignore — keep generic message
    }
    const wrapper = document.createElement('span');
    // B-36: the 0-facts case had previously fallen through to the
    // same wording ("0 facts found") that looked like an in-progress
    // state to the user. Surface the empty-decompose explicitly so
    // the PO can navigate to the Decide page and see why.
    if (factCount === 0) {
      wrapper.textContent = '추출된 사실 없음 · ';
    } else if (factCount !== null && factCount > 0) {
      wrapper.textContent = `${factCount}건 추출됨 · `;
    }
    wrapper.appendChild(makeReviewLink(jobId));
    setDetail(wrapper);
    stopPolling();
    // feat/capture-complete-toast: escalate to system notification
    // so a backgrounded tab (where Chrome throttles or hides the
    // in-page toast) still sees "분석 완료".
    announceTerminal(jobId, 'structured', factCount);
    scheduleFadeOut();
  } else if (
    status === 'extract_failed'
    || status === 'structure_failed'
  ) {
    setStatusText('저장 실패', true);
    setDetail(body.error_message || 'Pending Queue 에서 확인하세요.');
    stopPolling();
    announceTerminal(jobId, status, null);
    scheduleFadeOut();
  } else {
    renderInitial(status, jobId, undefined);
  }
}

/**
 * Ask the service worker to fire a system notification when a
 * terminal status is observed. Best-effort — the SW handler
 * silently no-ops if the `notifications` permission is missing.
 * This is the only out-of-tab feedback path for users who have
 * switched tabs (and so Chrome has throttled the content script).
 */
function announceTerminal(
  jobId: string,
  status: Status,
  factCount: number | null,
): void {
  try {
    chrome.runtime.sendMessage({
      type: 'announce_terminal',
      job_id: jobId,
      status,
      fact_count: factCount,
    }).catch(() => {});
  } catch {
    // SW may be momentarily unreachable — ignore.
  }
}

function pollTick(jobId: string): void {
  attempts++;
  if (attempts > POLL_MAX_ATTEMPTS) {
    stopPolling();
    setStatusText('처리 지연');
    setDetail('Pending Queue 에서 최신 상태를 확인하세요.');
    scheduleFadeOut();
    return;
  }
  // Step down to a slower cadence after the fast-poll budget is
  // exhausted, so a slow structure stage isn't an API hammer.
  if (attempts === POLL_FAST_ATTEMPTS && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = window.setInterval(
      () => pollTick(jobId),
      POLL_INTERVAL_SLOW_MS,
    );
  }
  (async () => {
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
  })();
}

function startPolling(jobId: string): void {
  stopPolling();
  attempts = 0;
  pollTimer = window.setInterval(
    () => pollTick(jobId),
    POLL_INTERVAL_FAST_MS,
  );
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
