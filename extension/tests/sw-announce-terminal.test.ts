/**
 * fix/popup-auto-cleanup-on-terminal — SW announce_terminal handler.
 *
 * Covers the auto-cleanup contract on the announce_terminal path
 * (the toast / push-side completion announcement):
 *   - status === 'validated'   → tracker row auto-dismissed
 *   - status === 'discarded'   → tracker row auto-dismissed
 *   - status === 'structured'  → tracker row flips to 'completed'
 *                                (still visible — 검토 대기 카드 유지)
 *   - status === 'extract_failed' → tracker row flips to 'failed'
 *
 * The OS notification call is best-effort and not asserted on the
 * validated/discarded path (the implementation deliberately skips it
 * — backend has already finalised so a re-attention popup would only
 * noise the user). For structured/extract_failed we just confirm the
 * tracker mutation; the notification create stub is silent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addJob,
  clearAllJobs,
  getJobs,
} from "@/background/job-tracker";

declare const chrome: {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn> };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
    lastError: chrome.runtime.LastError | undefined;
    getURL: ReturnType<typeof vi.fn>;
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
  notifications: {
    create: ReturnType<typeof vi.fn>;
  };
};

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
  chrome.runtime.sendMessage.mockReset();
  chrome.runtime.onMessage.addListener.mockReset();
  chrome.runtime.onInstalled.addListener.mockReset();
  chrome.storage.local.get.mockReset();
  chrome.storage.local.set.mockReset();
  chrome.action.setBadgeText.mockReset();
  chrome.action.setBadgeBackgroundColor.mockReset();
  chrome.notifications.create.mockReset();
  // Default: notifications.create resolves immediately so the SW
  // handler can proceed past the await new Promise(...) wrapper.
  chrome.notifications.create.mockImplementation(
    (_id: string, _opts: unknown, cb?: () => void) => { if (cb) cb(); },
  );
  chrome.runtime.lastError = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
});

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

describe("SW announce_terminal — auto-cleanup on backend-terminal", () => {
  it("validated → auto-dismisses tracker row, no OS notification fired", async () => {
    installMemStorage();
    await clearAllJobs();
    await addJob({
      job_id: "ann-validated",
      source_url: "https://e.com/v",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      {
        type: "announce_terminal",
        job_id: "ann-validated",
        status: "validated",
        fact_count: null,
      },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({ ok: true });
    const jobs = await getJobs();
    expect(jobs.find((j) => j.job_id === "ann-validated")).toBeUndefined();
    // validated → 사용자가 이미 결과 알고 있음. OS notification 은 조용히
    // 건너뛴다 (PO 요청: "자동 사라짐").
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it("discarded → auto-dismisses tracker row, no OS notification fired", async () => {
    installMemStorage();
    await clearAllJobs();
    await addJob({
      job_id: "ann-discarded",
      source_url: "https://e.com/d",
      status: "saving",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      {
        type: "announce_terminal",
        job_id: "ann-discarded",
        status: "discarded",
        fact_count: null,
      },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({ ok: true });
    const jobs = await getJobs();
    expect(jobs.find((j) => j.job_id === "ann-discarded")).toBeUndefined();
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it("structured → flips tracker row to 'completed' (검토 대기 카드 유지)", async () => {
    installMemStorage();
    await clearAllJobs();
    await addJob({
      job_id: "ann-structured",
      source_url: "https://e.com/s",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      {
        type: "announce_terminal",
        job_id: "ann-structured",
        status: "structured",
        fact_count: 4,
      },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({ ok: true });
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "ann-structured");
    expect(j?.status).toBe("completed");
    expect(j?.fact_count).toBe(4);
    // structured 는 사용자 검토 필요 → OS notification 발사 (분석 완료).
    expect(chrome.notifications.create).toHaveBeenCalled();
  });

  it("extract_failed → flips tracker row to 'failed' (사용자 인지 필요)", async () => {
    installMemStorage();
    await clearAllJobs();
    await addJob({
      job_id: "ann-failed",
      source_url: "https://e.com/f",
      status: "analyzing",
    });

    const listener = await importSw();
    let response: unknown = undefined;
    listener(
      {
        type: "announce_terminal",
        job_id: "ann-failed",
        status: "extract_failed",
        fact_count: null,
      },
      {},
      (r) => { response = r; },
    );

    await waitFor(() => response !== undefined);
    expect(response).toMatchObject({ ok: true });
    const jobs = await getJobs();
    const j = jobs.find((x) => x.job_id === "ann-failed");
    expect(j?.status).toBe("failed");
    // extract_failed 는 사용자 인지/재시도 결정 필요 → OS notification 발사.
    expect(chrome.notifications.create).toHaveBeenCalled();
  });
});
