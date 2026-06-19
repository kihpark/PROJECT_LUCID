/**
 * B-58 — Quick Lucid popup. See section comments inline.
 */
import { getHomeBrief, type HomeBrief } from "@/lib/api";
import { getAuth, openLogin, WEB_BASE } from "@/lib/auth";

interface CaptureResultMessage {
  ok: boolean;
  job_id?: string;
  error?: string;
}

const RECENT_LIMIT = 3;
const CLAIM_TRUNCATE = 64;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("missing #" + id);
  return node as T;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
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

  loadBrief(brief);
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
    const resp = (await chrome.runtime.sendMessage({
      type: "capture",
      source_url: activeTab.url,
      source_type: "web_article",
    })) as CaptureResultMessage;

    if (resp?.ok) {
      surfaceResult(body, true, "저장됨 · " + (resp.job_id || "").slice(0, 8));
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
