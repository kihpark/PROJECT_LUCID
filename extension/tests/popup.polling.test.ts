/**
 * fix/popup-polling-status-recover — popup-side regression for PO #2.
 *
 * PO observed 4 popup cards stuck on "저장 중… (확인 필요)" while
 * the backend had already moved the source_jobs to terminal states.
 * The fix:
 *   1. popup boot → forceCheckInflightJobs() for every saving/analyzing
 *      row (via SW message `force_check_status`).
 *   2. ↻ refresh → same fan-out (covered by the boot test since runRefresh
 *      → refreshAll → forceCheckInflightJobs).
 *   3. the SW handler returns ok and the storage-onChanged listener
 *      re-renders the card with the terminal pill.
 *
 * These tests do NOT cover the SW handler itself — see
 * sw-force-check.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { create: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  runtime: { sendMessage: ReturnType<typeof vi.fn> };
  storage: { onChanged: { addListener: ReturnType<typeof vi.fn> } };
};

interface CookieDetails { url: string; name: string }
interface TrackedJob {
  job_id: string;
  source_url: string;
  title?: string;
  status: "saving" | "analyzing" | "completed" | "failed";
  created_at: number;
  completed_at?: number;
  fact_count?: number;
  error_message?: string;
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

function stubFetchReject(err: unknown = new Error("network down")) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
}

interface MsgRouter {
  jobs?: TrackedJob[];
  forceCheckResponse?: (jobId: string) => Promise<unknown>;
}

function stubSendMessage(opts: MsgRouter) {
  const jobs = opts.jobs ?? [];
  chrome.runtime.sendMessage.mockImplementation((msg: { type?: string; job_id?: string }) => {
    if (msg?.type === "list_jobs") return Promise.resolve({ ok: true, jobs });
    if (msg?.type === "get_settings")
      return Promise.resolve({ ok: true, settings: { trackingEnabled: true } });
    if (msg?.type === "force_check_status") {
      if (opts.forceCheckResponse) return opts.forceCheckResponse(msg.job_id!);
      return Promise.resolve({ ok: true, server_status: "structured", tracker_status: "completed" });
    }
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
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function forceCheckCalls(): Array<{ type: string; job_id: string }> {
  return chrome.runtime.sendMessage.mock.calls
    .map((c: unknown[]) => c[0] as { type?: string; job_id?: string })
    .filter((m) => m?.type === "force_check_status")
    .map((m) => ({ type: m.type as string, job_id: m.job_id as string }));
}

describe("popup boot — auto force_check_status for every inflight row", () => {
  it("sends one force_check_status per saving/analyzing job on initial boot", async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        { job_id: "j-save", source_url: "https://e.com/a", status: "saving", created_at: Date.now() - 200_000 },
        { job_id: "j-an", source_url: "https://e.com/b", status: "analyzing", created_at: Date.now() - 200_000 },
        { job_id: "j-done", source_url: "https://e.com/c", status: "completed", created_at: Date.now() - 200_000, completed_at: Date.now() - 100_000 },
      ],
    });

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const calls = forceCheckCalls();
    const ids = calls.map((c) => c.job_id).sort();
    // saving + analyzing fired; completed did NOT.
    expect(ids).toEqual(["j-an", "j-save"]);
  });

  it("does not send any force_check_status when there are zero inflight rows", async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        { job_id: "done-1", source_url: "https://e.com/1", status: "completed", created_at: Date.now() - 100_000, completed_at: Date.now() - 50_000 },
        { job_id: "fail-1", source_url: "https://e.com/2", status: "failed", created_at: Date.now() - 100_000, completed_at: Date.now() - 50_000 },
      ],
    });

    await import("@/popup/popup.ts");
    await flushManyTimes();

    expect(forceCheckCalls()).toEqual([]);
  });
});

describe("popup ↻ refresh — re-fires force_check_status for inflight rows", () => {
  it("clicking the refresh button re-fans force_check_status across all current inflight rows", async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        { job_id: "still-saving", source_url: "https://e.com/x", status: "saving", created_at: Date.now() - 200_000 },
      ],
    });

    await import("@/popup/popup.ts");
    await flushManyTimes();

    const initialCount = forceCheckCalls().length;
    expect(initialCount).toBe(1);

    const refreshBtn = document.getElementById("review-refresh-btn") as HTMLButtonElement | null;
    expect(refreshBtn).not.toBeNull();
    refreshBtn!.click();
    await flushManyTimes();

    // After one click we expect a second fan-out.
    expect(forceCheckCalls().length).toBeGreaterThanOrEqual(initialCount + 1);
  });
});

describe("popup boot — failure on force_check_status does not crash render", () => {
  it("a rejecting force_check_status message is swallowed; cards still render", async () => {
    stubLoggedIn();
    stubFetchReject();
    stubSendMessage({
      jobs: [
        { job_id: "j1", source_url: "https://e.com/q", status: "saving", created_at: Date.now() - 200_000 },
      ],
      forceCheckResponse: () => Promise.reject(new Error("offline")),
    });

    await import("@/popup/popup.ts");
    await flushManyTimes();

    // Card rendered despite force_check_status reject.
    expect(document.querySelectorAll(".tracker-job").length).toBe(1);
    // The fan-out still fired.
    expect(forceCheckCalls().length).toBe(1);
  });
});
