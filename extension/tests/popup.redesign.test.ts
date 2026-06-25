/**
 * feat/quick-lucid-popup-redesign — PO 보고 #2 / #3 / #6 회귀 방어.
 *
 *   #2 — 단일 검토 박스: 검증 대기 box + 이번 세션 box 가 합쳐졌는지.
 *   #3 — 검증 대기 카운트 옆 /pending 진입 link 가 살아있는지.
 *   #6 — 새로고침 버튼이 SW message + brief refetch 를 동시에 트리거하는지.
 *
 * Also covers fact-level info hide regression — recent_validated 목록과
 * tracker-job 카드의 X건 추출됨 라벨이 모두 숨겨졌는지.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { create: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  runtime: { sendMessage: ReturnType<typeof vi.fn> };
  storage: { onChanged: { addListener: ReturnType<typeof vi.fn> } };
};

interface CookieDetails {
  url: string;
  name: string;
}

function resetDom() {
  document.body.innerHTML = `
    <div id="root" data-state="loading">
      <header class="header">
        <h1 class="brand">Quick Lucid</h1>
        <span id="space-name" class="space" hidden></span>
      </header>
      <main id="body">
        <p class="loading">Loading...</p>
      </main>
    </div>
  `;
}

function stubLoggedIn() {
  chrome.cookies.get.mockImplementation(
    (details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({
        value: details.name === "lucid_jwt" ? "jwt-xyz" : "ks-1",
      } as chrome.cookies.Cookie);
    },
  );
}

function stubFetchBrief(pendingValidation: number, recent: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        totals: { facts: 0, entities: 0, sources: 0, this_week_validated: 0 },
        pending_validation: pendingValidation,
        recent_validated: recent,
        top_cluster: null,
        is_empty: false,
      }),
    }),
  );
}

function stubSendMessageJobs(jobs: unknown[]) {
  chrome.runtime.sendMessage.mockImplementation((msg: { type?: string }) => {
    if (msg?.type === "list_jobs") return Promise.resolve({ ok: true, jobs });
    if (msg?.type === "get_settings")
      return Promise.resolve({ ok: true, settings: { trackingEnabled: true } });
    if (msg?.type === "set_settings") return Promise.resolve({ ok: true });
    if (msg?.type === "clear_completed") return Promise.resolve({ ok: true });
    return Promise.resolve({ ok: false });
  });
}

beforeEach(() => {
  resetDom();
  vi.resetModules();
  vi.unstubAllGlobals();
  chrome.cookies.get.mockReset();
  chrome.tabs.create.mockReset();
  chrome.tabs.query.mockReset();
  chrome.runtime.sendMessage.mockReset();
  chrome.storage.onChanged.addListener.mockReset();
  vi.spyOn(window, "close").mockImplementation(() => {});
});

async function flushManyTimes(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// #2 unified review pane
describe("popup redesign #2 — unified review pane", () => {
  it("renders the brief-derived pending count AND the per-session job cards inside ONE #review-pane (no separate brief box)", async () => {
    stubLoggedIn();
    stubFetchBrief(7);
    stubSendMessageJobs([
      {
        job_id: "job-1",
        source_url: "https://example.com/x",
        title: "Session capture",
        status: "analyzing",
        created_at: Date.now() - 1000,
      },
    ]);

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const pane = document.getElementById("review-pane");
    expect(pane).not.toBeNull();
    const pending = pane!.querySelector(".brief-pending");
    expect(pending?.textContent).toBe("7");
    expect(pane!.querySelectorAll(".tracker-job").length).toBe(1);
    // The pre-redesign standalone "이번 세션" heading is gone.
    expect(document.querySelector(".tracker-heading-label")).toBeNull();
  });
});

// #3 PENDING link
describe("popup redesign #3 — /pending entry link", () => {
  it("clicking 검토 대기 N건 link opens /pending in a new tab and closes the popup", async () => {
    stubLoggedIn();
    stubFetchBrief(4);
    stubSendMessageJobs([]);
    chrome.tabs.create.mockImplementation(() => {});

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const link = document.querySelector(
      ".review-pending-link",
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.textContent).toMatch(/검토 대기/);
    expect(link!.textContent).toMatch(/4/);
    expect(link!.querySelector(".review-pending-chevron")?.textContent).toMatch(/›/);

    link!.click();
    await flushManyTimes();

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const arg = chrome.tabs.create.mock.calls[0]?.[0] as { url: string };
    expect(arg.url).toBe("http://localhost:3000/pending");
  });
});

// #6 refresh
describe("popup redesign #6 — refresh button", () => {
  it("clicking the refresh button re-issues list_jobs + get_settings + /api/home/brief and re-renders the pane", async () => {
    stubLoggedIn();
    stubFetchBrief(2);
    stubSendMessageJobs([]);

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const refresh = document.getElementById(
      "review-refresh-btn",
    ) as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();

    const beforeListJobs = chrome.runtime.sendMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type?: string })?.type === "list_jobs",
    ).length;

    // Repoint brief to a new value + reset the fetch spy so we can
    // assert ONLY the refresh-triggered request.
    stubFetchBrief(9);
    const freshFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    refresh!.click();
    await flushManyTimes();

    const afterListJobs = chrome.runtime.sendMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type?: string })?.type === "list_jobs",
    ).length;

    expect(afterListJobs).toBeGreaterThan(beforeListJobs);
    expect(freshFetch.mock.calls.length).toBeGreaterThan(0);

    expect(
      document.querySelector(".brief-pending")?.textContent,
    ).toBe("9");
  });

  it("refresh button is disabled + carries the is-refreshing spinner class while the refresh is in flight", async () => {
    stubLoggedIn();
    stubFetchBrief(1);
    stubSendMessageJobs([]);

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const refresh = document.getElementById(
      "review-refresh-btn",
    ) as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();

    let releaseFetch: ((v: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((res) => {
          releaseFetch = res;
        }),
      ),
    );

    refresh!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(refresh!.disabled).toBe(true);
    expect(refresh!.className).toMatch(/is-refreshing/);

    releaseFetch?.({
      ok: true,
      status: 200,
      json: async () => ({
        totals: { facts: 0, entities: 0, sources: 0, this_week_validated: 0 },
        pending_validation: 1,
        recent_validated: [],
        top_cluster: null,
        is_empty: false,
      }),
    });
    await flushManyTimes();

    expect(refresh!.disabled).toBe(false);
    expect(refresh!.className).not.toMatch(/is-refreshing/);
  });
});

// fact level hide regression
describe("popup redesign — fact-level info hidden on job cards", () => {
  it("a completed job card with fact_count does NOT render the N건 추출됨 line — popup stays at the job altitude", async () => {
    stubLoggedIn();
    stubFetchBrief(0);
    stubSendMessageJobs([
      {
        job_id: "job-done",
        source_url: "https://example.com/x",
        title: "Article that yielded 5 facts",
        status: "completed",
        created_at: Date.now() - 60_000,
        completed_at: Date.now() - 5000,
        fact_count: 5,
      },
    ]);

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const card = document.querySelector(".tracker-job");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".tracker-facts")).toBeNull();
    expect(card!.textContent || "").not.toMatch(/건 추출/);
    expect(card!.querySelector(".tracker-review-btn")).not.toBeNull();
  });
});
