/**
 * B-58 — Quick Lucid popup. See section comments inline.
 *
 * feat/capture-job-tracker — popup-as-FAB. The popup now hosts a
 * pull-based "이번 세션" job tracker pane below the brief. Each card
 * shows status / elapsed / fact_count and a 검토하기 → button for
 * completed jobs. Two storage sources of truth:
 *   - brief.pending_validation  → canonical "검증 대기 N" (web)
 *   - tracker (lucid_jobs)      → per-session list, drives the badge
 * The two are independent on purpose: tracker = "since I last opened",
 * brief = "across the whole space".
 */
import { getHomeBrief, type HomeBrief } from "@/lib/api";
import { getAuth, openLogin, WEB_BASE } from "@/lib/auth";

interface CaptureResultMessage {
  ok: boolean;
  job_id?: string;
  error?: string;
}

// feat/capture-job-tracker — shape mirrors background/job-tracker
// TrackedJob. We do NOT import from @/background/job-tracker because
// the popup bundle would then pull in chrome.storage wrappers it
// never uses; all reads go via SW messages.
type TrackedJobStatus = "saving" | "analyzing" | "completed" | "failed";
interface TrackedJob {
  job_id: string;
  source_url: string;
  title?: string;
  status: TrackedJobStatus;
  created_at: number;
  completed_at?: number;
  fact_count?: number;
  error_message?: string;
  source_tab_id?: number;
}
interface TrackerSettings {
  trackingEnabled: boolean;
}

const RECENT_LIMIT = 3;
const CLAIM_TRUNCATE = 64;
const TRACKER_TITLE_TRUNCATE = 46;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("missing #" + id);
  return node as T;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatRelative(ms: number): string {
  // Cheap Korean relative-time labels. We only need second-precision
  // tracker entries — no need to pull a full Intl.RelativeTimeFormat
  // tree for a popup that lives on screen for seconds.
  const diff = Date.now() - ms;
  if (diff < 30_000) return "방금";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}

function renderLoggedOut(body: HTMLElement) {
  body.innerHTML = "";
  const actions = document.createElement("div");
  actions.className = "actions";

  const blurb = document.createElement("p");
  blurb.className = "muted";
  blurb.textContent = "로그인 후 캡처 / 질문이 가능합니다.";

  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "lucid.app 에서 로그인";
  btn.addEventListener("click", () => {
    openLogin();
    window.close();
  });

  actions.append(blurb, btn);
  body.appendChild(actions);
}

function renderBrief(container: HTMLElement, brief: HomeBrief): void {
  container.innerHTML = "";
  container.className = "brief";

  const row = document.createElement("div");
  row.className = "brief-row";

  const label = document.createElement("span");
  label.className = "brief-label";
  label.textContent = "검증 대기";

  const pending = document.createElement("span");
  pending.className = "brief-pending";
  pending.textContent = String(brief.pending_validation ?? 0);

  row.append(label, pending);
  container.appendChild(row);

  const recent = (brief.recent_validated ?? []).slice(0, RECENT_LIMIT);
  if (recent.length > 0) {
    const list = document.createElement("ul");
    list.className = "brief-recent";
    for (const item of recent) {
      const li = document.createElement("li");
      const subj = document.createElement("span");
      subj.className = "subject";
      subj.textContent = item.subject_label || "—";
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "·";
      const claim = document.createElement("span");
      claim.className = "claim";
      claim.textContent = truncate(item.claim || "", CLAIM_TRUNCATE);
      li.append(subj, sep, claim);
      list.appendChild(li);
    }
    container.appendChild(list);
  }
}

function renderBriefFallback(container: HTMLElement): void {
  container.innerHTML = "";
  container.className = "brief";
  const p = document.createElement("p");
  p.className = "brief-fallback";
  p.textContent = "오늘의 brief 를 불러올 수 없습니다";
  container.appendChild(p);
}

async function loadBrief(container: HTMLElement): Promise<void> {
  try {
    const brief = await getHomeBrief();
    renderBrief(container, brief);
  } catch {
    renderBriefFallback(container);
  }
}

// ---------------------------------------------------------------------------
// feat/capture-job-tracker — tracker pane
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<TrackedJobStatus, string> = {
  saving: "저장 중",
  analyzing: "분석 중",
  completed: "완료",
  failed: "실패",
};

function computeStatusLabel(
  status: TrackedJobStatus,
  ageMs: number,
): string {
  if (status === "saving") {
    return ageMs > 60_000 ? "저장 중… (확인 필요)" : "저장 중…";
  }
  if (status === "analyzing") {
    return ageMs > 5 * 60_000 ? "분석 중… (지연)" : "분석 중…";
  }
  return STATUS_LABEL[status];
}

async function fetchTrackerState(): Promise<{
  jobs: TrackedJob[];
  settings: TrackerSettings;
}> {
  // The SW returns { ok, jobs } / { ok, settings }. Fail-soft on
  // either reject — popup must still render the brief block even
  // if storage is wedged.
  let jobs: TrackedJob[] = [];
  let settings: TrackerSettings = { trackingEnabled: true };
  try {
    const jobsResp = (await chrome.runtime.sendMessage({
      type: "list_jobs",
    })) as { ok?: boolean; jobs?: TrackedJob[] } | undefined;
    if (jobsResp?.ok && Array.isArray(jobsResp.jobs)) jobs = jobsResp.jobs;
  } catch {
    // ignore — empty list is fine
  }
  try {
    const settingsResp = (await chrome.runtime.sendMessage({
      type: "get_settings",
    })) as { ok?: boolean; settings?: TrackerSettings } | undefined;
    if (settingsResp?.ok && settingsResp.settings) {
      settings = settingsResp.settings;
    }
  } catch {
    // ignore — default settings used
  }
  return { jobs, settings };
}

function renderTrackerJobs(
  container: HTMLElement,
  jobs: TrackedJob[],
): void {
  container.innerHTML = "";
  if (jobs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tracker-empty";
    empty.textContent = "아직 캡처한 항목이 없어요.";
    container.appendChild(empty);
    return;
  }

  for (const job of jobs) {
    const card = document.createElement("div");
    card.className = "tracker-job";
    card.dataset.jobId = job.job_id;
    card.dataset.status = job.status;

    const top = document.createElement("div");
    top.className = "tracker-job-top";

    const title = document.createElement("span");
    title.className = "tracker-job-title";
    const displayTitle =
      (job.title && job.title.trim()) || hostnameOf(job.source_url);
    title.textContent = truncate(displayTitle, TRACKER_TITLE_TRUNCATE);
    title.title = job.title || job.source_url;
    top.appendChild(title);

    const pill = document.createElement("span");
    pill.className = `tracker-status ${job.status}`;
    // feat/state-sync-unification — derive label from elapsed time so
    // a stuck job surfaces a heartbeat warning instead of pretending
    // everything is fine. Mirrors background/job-tracker statusLabel().
    const ageMs = Date.now() - job.created_at;
    pill.textContent = computeStatusLabel(job.status, ageMs);
    if (
      (job.status === "saving" && ageMs > 60_000)
      || (job.status === "analyzing" && ageMs > 5 * 60_000)
    ) {
      pill.classList.add("tracker-status-stale");
    }
    top.appendChild(pill);

    card.appendChild(top);

    const meta = document.createElement("div");
    meta.className = "tracker-meta";

    const stamp = document.createElement("span");
    stamp.className = "tracker-time";
    const refTime =
      job.status === "completed" || job.status === "failed"
        ? (job.completed_at ?? job.created_at)
        : job.created_at;
    stamp.textContent = formatRelative(refTime);
    meta.appendChild(stamp);

    if (
      typeof job.fact_count === "number"
      && job.status === "completed"
    ) {
      const fc = document.createElement("span");
      fc.className = "tracker-facts";
      fc.textContent =
        job.fact_count > 0 ? `${job.fact_count}건 추출됨` : "추출 0";
      meta.appendChild(fc);
    }

    if (job.status === "failed" && job.error_message) {
      const errSpan = document.createElement("span");
      errSpan.className = "tracker-error";
      errSpan.textContent = job.error_message;
      meta.appendChild(errSpan);
    }

    card.appendChild(meta);

    if (job.status === "completed") {
      const review = document.createElement("button");
      review.type = "button";
      review.className = "tracker-review-btn";
      review.textContent = "검토하기 →";
      review.addEventListener("click", () => {
        chrome.tabs.create({ url: `${WEB_BASE}/pending/${job.job_id}` });
        window.close();
      });
      card.appendChild(review);
    }

    container.appendChild(card);
  }
}

function renderTrackerPane(
  trackerSection: HTMLElement,
  jobs: TrackedJob[],
  settings: TrackerSettings,
): void {
  trackerSection.innerHTML = "";

  if (!settings.trackingEnabled) {
    // Off → single muted line so the user remembers it's a setting.
    const off = document.createElement("p");
    off.className = "tracker-off";
    off.textContent = "작업 추적 꺼짐. 설정에서 켤 수 있어요.";
    trackerSection.appendChild(off);
    return;
  }

  const heading = document.createElement("div");
  heading.className = "tracker-heading";
  const headingLabel = document.createElement("span");
  headingLabel.className = "tracker-heading-label";
  headingLabel.textContent = "이번 세션";
  heading.appendChild(headingLabel);

  const summary = summarizeJobs(jobs);
  if (summary.total > 0) {
    const meta = document.createElement("span");
    meta.className = "tracker-heading-meta";
    const parts: string[] = [];
    if (summary.inflight > 0) parts.push(`진행 ${summary.inflight}`);
    if (summary.ready > 0) parts.push(`완료 ${summary.ready}`);
    if (summary.failed > 0) parts.push(`실패 ${summary.failed}`);
    meta.textContent = parts.join(" · ");
    heading.appendChild(meta);
  }
  trackerSection.appendChild(heading);

  const list = document.createElement("div");
  list.className = "tracker-list";
  renderTrackerJobs(list, jobs);
  trackerSection.appendChild(list);

  const hasResolved = jobs.some(
    (j) => j.status === "completed" || j.status === "failed",
  );
  if (hasResolved) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "tracker-clear-btn";
    clearBtn.textContent = "완료 항목 정리";
    clearBtn.addEventListener("click", async () => {
      try {
        await chrome.runtime.sendMessage({ type: "clear_completed" });
      } catch {
        // ignore — re-render below will pull whatever's left
      }
      await refreshTracker();
    });
    trackerSection.appendChild(clearBtn);
  }
}

function summarizeJobs(jobs: TrackedJob[]): {
  inflight: number;
  ready: number;
  failed: number;
  total: number;
} {
  let inflight = 0;
  let ready = 0;
  let failed = 0;
  for (const j of jobs) {
    if (j.status === "saving" || j.status === "analyzing") inflight++;
    else if (j.status === "completed") ready++;
    else if (j.status === "failed") failed++;
  }
  return { inflight, ready, failed, total: jobs.length };
}

function renderTrackerSettings(
  container: HTMLElement,
  settings: TrackerSettings,
): void {
  container.innerHTML = "";
  const wrap = document.createElement("label");
  wrap.className = "tracker-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = settings.trackingEnabled;
  cb.addEventListener("change", async () => {
    try {
      await chrome.runtime.sendMessage({
        type: "set_settings",
        patch: { trackingEnabled: cb.checked },
      });
    } catch {
      // ignore — refresh below pulls authoritative state
    }
    await refreshTracker();
  });
  const lbl = document.createElement("span");
  lbl.textContent = "작업 추적 표시";
  wrap.append(cb, lbl);
  container.appendChild(wrap);
}

let trackerRefreshing = false;
async function refreshTracker(): Promise<void> {
  if (trackerRefreshing) return;
  trackerRefreshing = true;
  try {
    const trackerSection = document.getElementById("tracker");
    const settingsSection = document.getElementById("tracker-settings");
    if (!trackerSection || !settingsSection) return;
    const { jobs, settings } = await fetchTrackerState();
    renderTrackerPane(trackerSection, jobs, settings);
    renderTrackerSettings(settingsSection, settings);
  } finally {
    trackerRefreshing = false;
  }
}

function installStorageListener(): void {
  // Live-refresh the tracker pane when the SW writes a new state
  // while the popup is open (the typical case: user opens popup
  // mid-capture, structuring completes, the SW flips the row to
  // "completed" — we want the pill to update without the user
  // closing + reopening the popup).
  try {
    if (
      typeof chrome !== "undefined"
      && chrome.storage?.onChanged?.addListener
    ) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.lucid_jobs || changes.lucid_settings) {
          void refreshTracker();
        }
      });
    }
  } catch {
    // ignore — listener install is best-effort
  }
}

function renderLoggedIn(
  body: HTMLElement,
  _spaceId: string,
): void {
  body.innerHTML = "";

  const brief = document.createElement("section");
  brief.id = "brief";
  brief.className = "brief";
  brief.dataset.state = "loading";
  const loading = document.createElement("p");
  loading.className = "brief-fallback";
  loading.textContent = "오늘의 brief 불러오는 중…";
  brief.appendChild(loading);
  body.appendChild(brief);

  const actions = document.createElement("div");
  actions.className = "actions";

  const capture = document.createElement("button");
  capture.id = "capture-btn";
  capture.className = "primary";
  capture.textContent = "이 페이지 캡처";
  capture.addEventListener("click", () => onCapture(capture, body));
  actions.appendChild(capture);

  const ask = document.createElement("div");
  ask.className = "ask";
  const input = document.createElement("input");
  input.id = "ask-input";
  input.type = "text";
  input.placeholder = "빠른 질문…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      onAsk(input);
    }
  });
  const askBtn = document.createElement("button");
  askBtn.id = "ask-btn";
  askBtn.textContent = "물어보기";
  askBtn.addEventListener("click", () => onAsk(input));
  ask.append(input, askBtn);
  actions.appendChild(ask);

  const home = document.createElement("button");
  home.id = "home-btn";
  home.className = "link";
  home.textContent = "Lucid 홈 열기 →";
  home.addEventListener("click", () => {
    chrome.tabs.create({ url: WEB_BASE + "/home" });
    window.close();
  });
  actions.appendChild(home);

  body.appendChild(actions);

  const result = document.createElement("div");
  result.id = "capture-result";
  result.hidden = true;
  body.appendChild(result);

  // feat/capture-job-tracker — tracker pane lives BELOW the actions
  // so the primary capture affordance stays above the fold; tracker
  // is review-oriented, captureBtn is action-oriented.
  const tracker = document.createElement("section");
  tracker.id = "tracker";
  tracker.className = "tracker-pane";
  body.appendChild(tracker);

  const trackerSettings = document.createElement("section");
  trackerSettings.id = "tracker-settings";
  trackerSettings.className = "tracker-settings";
  body.appendChild(trackerSettings);

  loadBrief(brief);
  void refreshTracker();
  installStorageListener();
}

async function onCapture(btn: HTMLButtonElement, body: HTMLElement) {
  btn.disabled = true;
  btn.textContent = "캡처 중…";

  let activeTab: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch {
    activeTab = undefined;
  }

  if (!activeTab?.url) {
    surfaceResult(body, false, "활성 탭을 찾을 수 없습니다.");
    btn.disabled = false;
    btn.textContent = "이 페이지 캡처";
    return;
  }

  try {
    // pending-card-title-date: include the resolved page title so the
    // backend can stamp it into extracted_metadata pre-extract — the
    // Pending Queue card then renders the headline instead of the
    // raw hostname. `tab.title` is the same string the browser shows
    // in the tab strip; safe to forward without any DOM-script eval.
    const resp = (await chrome.runtime.sendMessage({
      type: "capture",
      source_url: activeTab.url,
      source_type: "web_article",
      page_title: activeTab.title ?? "",
    })) as CaptureResultMessage;

    if (resp?.ok) {
      surfaceResult(body, true, "저장됨 · " + (resp.job_id || "").slice(0, 8));
      // feat/capture-job-tracker — the SW already added the row, but
      // the storage onChanged event sometimes lags in jsdom-style
      // races. Pull explicitly so the user sees the new card before
      // the popup auto-closes.
      void refreshTracker();
    } else {
      surfaceResult(body, false, resp?.error || "캡처 실패");
    }
  } catch (err) {
    surfaceResult(body, false, (err as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = "이 페이지 캡처";
  }
}

function onAsk(input: HTMLInputElement) {
  const q = (input.value || "").trim();
  if (!q) {
    input.focus();
    return;
  }
  const url = WEB_BASE + "/recall?q=" + encodeURIComponent(q);
  chrome.tabs.create({ url });
  window.close();
}

function surfaceResult(body: HTMLElement, ok: boolean, message: string) {
  let res = body.querySelector<HTMLElement>("#capture-result");
  if (!res) {
    res = document.createElement("div");
    res.id = "capture-result";
    body.appendChild(res);
  }
  res.hidden = false;
  res.className = ok ? "" : "error";
  res.textContent = message;
}

async function boot() {
  const root = el("root");
  const body = el("body");
  const spaceLabel = el("space-name");

  try {
    const auth = await getAuth();
    root.dataset.state = auth ? "ready" : "logged_out";
    if (auth) {
      spaceLabel.hidden = false;
      spaceLabel.textContent = auth.spaceId.slice(0, 8);
      renderLoggedIn(body, auth.spaceId);
    } else {
      renderLoggedOut(body);
    }
  } catch {
    renderLoggedOut(body);
  }
}

boot();
