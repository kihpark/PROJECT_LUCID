/**
 * B-58 — Quick Lucid popup. See section comments inline.
 *
 * feat/quick-lucid-popup-redesign — capture-job-tracker 후속 UX 정리.
 * Pre-fix the popup had two separate review boxes — a "검증 대기" brief
 * row above + a "이번 세션" job tracker below. PO complaint (#2/#3/#6):
 *   - 두 박스가 따로 살아서 검토 동선이 흩어진다 (#2)
 *   - 검증 대기 N 옆에 진입 link 가 없어서 어디로 가야 할지 모른다 (#3)
 *   - popup 을 새로 열기 전엔 갱신을 강제할 수 없다 (#6)
 *
 * Now:
 *   - 단일 "검토 대기 N건 ›" 헤더 (link 로 /pending 열기 + 새로고침 버튼).
 *   - 헤더 아래에 job 카드 (저장중 / 분석중 / 완료 / 실패).
 *   - 카드의 fact 레벨 정보 (X건 추출됨, recent_validated claim 목록) 는 숨김 —
 *     검토 동선을 단일 entrypoint 로 좁히기 위함.
 *
 * Two storage sources of truth (변하지 않음):
 *   - brief.pending_validation  → 헤더의 "검토 대기 N건" 카운트 (web)
 *   - tracker (lucid_jobs)      → 카드 리스트 (per-session)
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

// ---------------------------------------------------------------------------
// feat/quick-lucid-popup-redesign — unified review pane
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
  // either reject — the review pane must still render its header
  // (with the brief-derived pending count) even if storage is wedged.
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

interface ReviewPaneState {
  pendingCount: number | null;
  briefFailed: boolean;
  jobs: TrackedJob[];
  settings: TrackerSettings;
}

function renderJobCard(job: TrackedJob): HTMLElement {
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
  // feat/state-sync-unification — heartbeat escalation: stale jobs
  // surface a warning label (저장중 60s+ → "확인 필요", 분석중 5min+ → "지연")
  // instead of pretending everything is fine. Mirrors background/job-tracker
  // statusLabel(). The matching .tracker-status-stale CSS dims + warns.
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

  // feat/quick-lucid-popup-redesign — meta strip now carries ONLY the
  // timestamp (and failure reason when present). Fact-level details
  // such as "X건 추출됨" are intentionally hidden so the popup card
  // stays at the job altitude — the user resolves details on /pending.
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

  return card;
}

function renderReviewPane(
  pane: HTMLElement,
  state: ReviewPaneState,
): void {
  pane.innerHTML = "";

  // ── Header ──────────────────────────────────────────────────────────
  // "검토 대기 N건 ›" — link to /pending — + 새로고침 버튼.
  // The header sits even when tracking is off so the pending link is
  // never hidden behind a toggle. The job list below collapses to the
  // "off" message when trackingEnabled is false.
  const header = document.createElement("div");
  header.className = "review-header";

  const pendingLink = document.createElement("a");
  pendingLink.className = "review-pending-link";
  pendingLink.href = `${WEB_BASE}/pending`;
  pendingLink.target = "_blank";
  pendingLink.rel = "noopener noreferrer";
  if (state.briefFailed) {
    pendingLink.textContent = "검토 대기 ›";
    pendingLink.classList.add("review-pending-link-fallback");
    pendingLink.title = "오늘의 brief 를 불러올 수 없습니다";
  } else {
    const count = state.pendingCount ?? 0;
    const label = document.createElement("span");
    label.className = "review-pending-label";
    label.textContent = "검토 대기 ";
    const countSpan = document.createElement("span");
    countSpan.className = "review-pending-count";
    countSpan.textContent = String(count);
    // brief-pending kept as an alias for tests / DOM consumers that
    // grew up around the pre-redesign class name.
    countSpan.classList.add("brief-pending");
    const suffix = document.createElement("span");
    suffix.className = "review-pending-suffix";
    suffix.textContent = "건";
    const chevron = document.createElement("span");
    chevron.className = "review-pending-chevron";
    chevron.textContent = " ›";
    pendingLink.append(label, countSpan, suffix, chevron);
  }
  pendingLink.addEventListener("click", (ev) => {
    // Hand the navigation to chrome.tabs so it lands in a new tab
    // consistently across MV3 popup quirks where target=_blank from
    // a popup sometimes opens a no-op blank window before closing.
    ev.preventDefault();
    chrome.tabs.create({ url: `${WEB_BASE}/pending` });
    window.close();
  });
  header.appendChild(pendingLink);

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.id = "review-refresh-btn";
  refresh.className = "review-refresh-btn";
  refresh.title = "새로고침";
  refresh.setAttribute("aria-label", "새로고침");
  refresh.textContent = "↻";
  refresh.addEventListener("click", () => {
    void runRefresh(refresh);
  });
  header.appendChild(refresh);

  pane.appendChild(header);

  // ── Body ────────────────────────────────────────────────────────────
  if (!state.settings.trackingEnabled) {
    const off = document.createElement("p");
    off.className = "tracker-off";
    off.textContent = "작업 추적 꺼짐. 설정에서 켤 수 있어요.";
    pane.appendChild(off);
    return;
  }

  const list = document.createElement("div");
  list.className = "tracker-list";
  if (state.jobs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tracker-empty";
    empty.textContent = "아직 캡처한 항목이 없어요.";
    list.appendChild(empty);
  } else {
    for (const job of state.jobs) {
      list.appendChild(renderJobCard(job));
    }
  }
  pane.appendChild(list);

  const hasResolved = state.jobs.some(
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
        // ignore — re-render below will pull whatever is left
      }
      await refreshAll();
    });
    pane.appendChild(clearBtn);
  }
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
    await refreshAll();
  });
  const lbl = document.createElement("span");
  lbl.textContent = "작업 추적 표시";
  wrap.append(cb, lbl);
  container.appendChild(wrap);
}

let cachedBrief: { pendingCount: number | null; briefFailed: boolean } = {
  pendingCount: null,
  briefFailed: false,
};

async function loadBriefSnapshot(): Promise<{
  pendingCount: number | null;
  briefFailed: boolean;
}> {
  try {
    const brief: HomeBrief = await getHomeBrief();
    cachedBrief = {
      pendingCount: brief.pending_validation ?? 0,
      briefFailed: false,
    };
  } catch {
    cachedBrief = { pendingCount: null, briefFailed: true };
  }
  return cachedBrief;
}

let refreshing = false;
async function refreshAll(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const reviewSection = document.getElementById("review-pane");
    const settingsSection = document.getElementById("tracker-settings");
    if (!reviewSection || !settingsSection) return;
    // Pull brief + tracker in parallel — both are independent reads
    // and a slow brief should not block tracker hydration.
    const [briefSnap, tracker] = await Promise.all([
      loadBriefSnapshot(),
      fetchTrackerState(),
    ]);
    renderReviewPane(reviewSection, {
      pendingCount: briefSnap.pendingCount,
      briefFailed: briefSnap.briefFailed,
      jobs: tracker.jobs,
      settings: tracker.settings,
    });
    renderTrackerSettings(settingsSection, tracker.settings);
  } finally {
    refreshing = false;
  }
}

async function refreshTrackerOnly(): Promise<void> {
  // Storage-onChanged triggers this. We keep the cached brief value
  // so the header count does not blink to 0 just because a job row
  // moved from analyzing → completed.
  if (refreshing) return;
  refreshing = true;
  try {
    const reviewSection = document.getElementById("review-pane");
    const settingsSection = document.getElementById("tracker-settings");
    if (!reviewSection || !settingsSection) return;
    const tracker = await fetchTrackerState();
    renderReviewPane(reviewSection, {
      pendingCount: cachedBrief.pendingCount,
      briefFailed: cachedBrief.briefFailed,
      jobs: tracker.jobs,
      settings: tracker.settings,
    });
    renderTrackerSettings(settingsSection, tracker.settings);
  } finally {
    refreshing = false;
  }
}

async function runRefresh(btn: HTMLButtonElement): Promise<void> {
  // feat/quick-lucid-popup-redesign — 새로고침 버튼. The SW already
  // polls in-flight jobs on its own cadence; we explicitly query the
  // tracker store + brief here so the user sees the latest state
  // without re-opening the popup.
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("is-refreshing");
  try {
    await refreshAll();
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-refreshing");
  }
}

function installStorageListener(): void {
  // Live-refresh the tracker list when the SW writes a new state
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
          void refreshTrackerOnly();
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

  // feat/quick-lucid-popup-redesign — single unified review pane.
  // No more separate brief box + tracker pane — the header carries
  // the brief-derived pending count + /pending link + 새로고침,
  // and the body holds the per-session job cards.
  const review = document.createElement("section");
  review.id = "review-pane";
  review.className = "review-pane";
  // Initial skeleton so the section has shape before refreshAll
  // finishes. Subsequent renders overwrite this entirely.
  const skeleton = document.createElement("p");
  skeleton.className = "brief-fallback";
  skeleton.textContent = "검토 대기 불러오는 중…";
  review.appendChild(skeleton);
  body.appendChild(review);

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

  // Tracker-settings lives at the bottom — it is a meta toggle for
  // the review pane above and stays out of the primary action stack.
  const trackerSettings = document.createElement("section");
  trackerSettings.id = "tracker-settings";
  trackerSettings.className = "tracker-settings";
  body.appendChild(trackerSettings);

  // Hidden alias element so any legacy DOM consumer that still
  // queries #tracker finds something. The unified review pane is
  // the canonical home for tracker state.
  const trackerAlias = document.createElement("section");
  trackerAlias.id = "tracker";
  trackerAlias.hidden = true;
  body.appendChild(trackerAlias);

  void refreshAll();
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
    // raw hostname. tab.title is the same string the browser shows
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
      void refreshAll();
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
