/**
 * fix/popup-polling-status-recover — SW handler regression for PO #2.
 * fix/sourcestatus-validated-enum — 500 fallback removed; 200 path now
 *   carries the real `validated` terminal state; 5xx propagates as error.
 *
 * Covers:
 *   1. fetchServerJobStatus (lib/api.ts) status-mapping contract:
 *      - 200 with `validated` -> ServerJobStatus parsed verbatim.
 *      - 200 with `structured` -> ServerJobStatus parsed verbatim.
 *      - 401 -> throws not_authenticated.
 *      - >=500 -> throws (regression guard for the removed synthetic
 *        `validated` workaround).
 *   2. The SW `force_check_status` handler status mapping by driving
 *      the registered chrome.runtime.onMessage listener:
 *      - server status `validated` -> tracker `completed`.
 *      - server status `structured` -> tracker `completed`.
 *      - server 5xx -> tracker row stays inflight (no mutation).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchServerJobStatus } from "@/lib/api";
import { COOKIE_SPACE, COOKIE_TOKEN } from "@/lib/auth";
import {
  addJob,
  clearAllJobs,
  getJobs,
} from "@/background/job-tracker";

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn> };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
    lastError: chrome.runtime.LastError | undefined;
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
  };
  action: {
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  };
};

interface CookieDetails { url: string; name: string }

function stubAuthCookies() {
  chrome.cookies.get.mockImplementation(
    (details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      const map: Record<string, string> = {
        [COOKIE_TOKEN]: "jwt-xyz",
        [COOKIE_SPACE]: "ks-1",
      };
      cb(
        map[details.name]
          ? ({ value: map[details.name] } as chrome.cookies.Cookie)
          : null,
      );
    },
  );
}

let memStore: Record<string, unknown> = {};
function installMemStorage() {
  memStore = {};
  chrome.storage.local.get.mockImplementation(
    (keys: string[] | string, cb?: (result: Record<string, unknown>) => void) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of arr) {
        if (k in memStore) out[k] = memStore[k];
      }
      if (cb) cb(out);
      return Promise.resolve(out);
    },
  );
  chrome.storage.local.set.mockImplementation(
    (items: Record<string, unknown>, cb?: () => void) => {
      Object.assign(memStore, items);
      if (cb) cb();
      return Promise.resolve();
    },
  );
}

beforeEach(() => {
  chrome.cookies.get.mockReset();
  chrome.runtime.sendMessage.mockReset();
  chrome.runtime.onMessage.addListener.mockReset();
  chrome.runtime.onInstalled.addListener.mockReset();
  chrome.storage.local.get.mockReset();
  chrome.storage.local.set.mockReset();
  chrome.action.setBadgeText.mockReset();
  chrome.action.setBadgeBackgroundColor.mockReset();
  chrome.runtime.lastError = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("fetchServerJobStatus -- server-truth status fetch", () => {
  it("returns parsed { status, error_message } on 200", async () => {
    stubAuthCookies();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "abc",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/x",
          source_type: "web_article",
          status: "structured",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: null,
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );
    const r = await fetchServerJobStatus("abc");
    expect(r).toEqual({ status: "structured", error_message: null });
  });

  it("parses 200 with validated status verbatim (SourceStatus enum gap fixed)", async () => {
    stubAuthCookies();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "abc",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/x",
          source_type: "web_article",
          status: "validated",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: null,
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );
    const r = await fetchServerJobStatus("abc");
    expect(r).toEqual({ status: "validated", error_message: null });
  });

  it("throws on HTTP 500 (regression guard — synthetic validated fallback removed)", async () => {
    stubAuthCookies();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: "Internal Server Error" }),
      }),
    );
    // Used to return { status: 'validated', error_message: null }. The
    // workaround is gone: a real 5xx must now bubble so the SW handler
    // keeps the tracker row inflight instead of silently marking it
    // completed during a backend outage.
    await expect(fetchServerJobStatus("abc")).rejects.toThrow();
  });

  it("throws not_authenticated on 401 (no silent terminal mark)", async () => {
    stubAuthCookies();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ detail: "not_authenticated" }),
      }),
    );
    await expect(fetchServerJobStatus("abc")).rejects.toThrow(/not_authenticated/);
  });
});

describe("SW force_check_status handler -- tracker mutation contract", () => {
  async function importSw(): Promise<
    (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
  > {
    await import("@/background/service-worker.ts");
    const calls = chrome.runtime.onMessage.addListener.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[0]![0] as (
      msg: unknown,
      sender: unknown,
      sendResponse: (r: unknown) => void,
    ) => boolean;
  }

  async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("structured -> flips tracker row to completed and reports server_status", async () => {
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "j1",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/y",
          source_type: "web_article",
          status: "structured",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: null,
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );

    await clearAllJobs();
    await addJob({ job_id: "j1", source_url: "https://e.com/y", status: "saving" });

    const listener = await importSw();
    let response: unknown = undefined;
    const ret = listener(
      { type: "force_check_status", job_id: "j1" },
      {},
      (r) => { response = r; },
    );
    expect(ret).toBe(true);

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({ ok: true, server_status: "structured" });
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "j1");
    expect(j?.status).toBe("completed");
  });

  it("extract_failed -> flips tracker row to failed with error_message", async () => {
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "j2",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/z",
          source_type: "web_article",
          status: "extract_failed",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: "404 from upstream",
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );

    await clearAllJobs();
    await addJob({ job_id: "j2", source_url: "https://e.com/z", status: "saving" });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      { type: "force_check_status", job_id: "j2" },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({ ok: true, server_status: "extract_failed" });
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "j2");
    expect(j?.status).toBe("failed");
    expect(j?.error_message).toBe("404 from upstream");
  });

  it("validated (200 path) -> auto-dismisses tracker row (fix/popup-auto-cleanup-on-terminal)", async () => {
    // fix/popup-auto-cleanup-on-terminal — validated 는 backend 가 검토를
    // 끝낸 상태. popup 검토 대기 카드에 남길 이유가 없으므로 즉시 tracker
    // 에서 제거 (사용자가 × 를 누를 필요 없음). 이전 동작은 'completed'
    // 로 유지였음 — 이 PR 이 동작을 변경한다.
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "j-validated",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/v",
          source_type: "web_article",
          status: "validated",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: null,
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );

    await clearAllJobs();
    await addJob({
      job_id: "j-validated",
      source_url: "https://e.com/v",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      { type: "force_check_status", job_id: "j-validated" },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({
      ok: true,
      server_status: "validated",
      tracker_status: "dismissed",
      auto_dismissed: true,
    });
    // Crucially: row is GONE — popup card list no longer shows it.
    const jobs = await getJobs();
    expect(jobs.find((x) => x.job_id === "j-validated")).toBeUndefined();
    // Badge update was called so the numeric counter resets.
    expect(chrome.action.setBadgeText).toHaveBeenCalled();
  });

  it("discarded (200 path) -> auto-dismisses tracker row (fix/popup-auto-cleanup-on-terminal)", async () => {
    // 'discarded' = user (or backend cleanup) 가 폐기 결정을 내린 상태.
    // validated 와 대칭으로, popup 검토 대기 카드에서 자동 사라져야 한다.
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "j-discarded",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/d",
          source_type: "web_article",
          status: "discarded",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: null,
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );

    await clearAllJobs();
    await addJob({
      job_id: "j-discarded",
      source_url: "https://e.com/d",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      { type: "force_check_status", job_id: "j-discarded" },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({
      ok: true,
      server_status: "discarded",
      tracker_status: "dismissed",
      auto_dismissed: true,
    });
    const jobs = await getJobs();
    expect(jobs.find((x) => x.job_id === "j-discarded")).toBeUndefined();
  });

  it("structured -> tracker row stays in list as 'completed' (검토 대기 유지)", async () => {
    // fix/popup-auto-cleanup-on-terminal regression guard — structured
    // 는 사용자 검토가 필요한 상태이므로 자동 dismiss 하면 안 된다.
    // 'completed' 라벨로 유지하여 popup 검토 대기 카드에 남는다.
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          job_id: "j-structured",
          knowledge_space_id: "ks-1",
          source_url: "https://e.com/s",
          source_type: "web_article",
          status: "structured",
          captured_at: "2026-06-24T08:00:00Z",
          captured_from: "chrome_ext",
          error_message: null,
          created_at: "2026-06-24T08:00:00Z",
          updated_at: "2026-06-24T08:00:00Z",
        }),
      }),
    );

    await clearAllJobs();
    await addJob({
      job_id: "j-structured",
      source_url: "https://e.com/s",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      { type: "force_check_status", job_id: "j-structured" },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({
      ok: true,
      server_status: "structured",
      tracker_status: "completed",
    });
    // Row remains, with terminal 'completed' status — user can still
    // see it and click × manually if desired (보조 escape hatch).
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "j-structured");
    expect(j?.status).toBe("completed");
  });

  it("5xx -> { ok: false, error } and tracker row stays inflight (regression guard)", async () => {
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: "Service Unavailable" }),
      }),
    );

    await clearAllJobs();
    await addJob({
      job_id: "j-5xx",
      source_url: "https://e.com/5xx",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: { ok: boolean; error?: string } | undefined = undefined;
    listener(
      { type: "force_check_status", job_id: "j-5xx" },
      {},
      (r) => { response = r as { ok: boolean; error?: string }; },
    );

    await waitFor(() => response !== undefined);
    const resp = response as unknown as { ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/HTTP 503|Service Unavailable/);
    // Crucially: tracker row stays 'analyzing'. The old synthetic-
    // validated workaround would have flipped this to 'completed'.
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "j-5xx");
    expect(j?.status).toBe("analyzing");
  });

  it("network failure -> { ok: false, error } and tracker row stays inflight", async () => {
    stubAuthCookies();
    installMemStorage();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await clearAllJobs();
    await addJob({ job_id: "j3", source_url: "https://e.com/w", status: "analyzing" });

    const listener = await importSw();
    let response: { ok: boolean; error?: string } | undefined = undefined;
    listener(
      { type: "force_check_status", job_id: "j3" },
      {},
      (r) => { response = r as { ok: boolean; error?: string }; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toBeDefined();
    const resp = response as unknown as { ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/network down/);
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "j3");
    expect(j?.status).toBe("analyzing");
  });
});
