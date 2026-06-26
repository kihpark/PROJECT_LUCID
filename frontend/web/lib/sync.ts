/**
 * feat/state-sync-unification — global state-change bus.
 *
 * PO diagnosis: "상태 변화가 실시간 전파되지 않는다." The backend is
 * the single source of truth; every display surface (HOME briefing,
 * LEDGER, 검증 tab badge, FAB, popup) needs to re-read from that
 * source the moment a write lands. We chose event-driven over polling
 * because polling either floods the API or trails the user.
 *
 * Two channels:
 *   1. `window` CustomEvent — same-tab fanout. AppShell, HomePage,
 *      LedgerView etc. subscribe via the `useStateChange` hook.
 *   2. `BroadcastChannel('lucid-sync')` — cross-tab fanout. A submit
 *      in tab A wakes up the AppShell badge in tab B without either
 *      tab polling. Falls back to the window event when the API is
 *      unavailable (older Safari, jsdom).
 *
 * The extension uses chrome.storage.onChanged for the same effect
 * (BroadcastChannel is not available inside a chrome.runtime
 * service worker context).
 */
'use client';

import { useEffect } from 'react';

const SYNC_EVENT = 'lucid:state-changed';
const SYNC_CHANNEL = 'lucid-sync';

export type SyncReason =
  | 'capture-submitted'
  | 'decision-submitted'
  | 'fact-retracted'
  | 'fact-restored'
  | 'fact-modified';

export interface SyncEventPayload {
  reason: SyncReason;
  payload?: unknown;
}

function safeChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SYNC_CHANNEL);
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget — dispatch a same-tab CustomEvent AND a cross-tab
 * BroadcastChannel message. Safe to call from any client code; no-ops
 * on the server.
 *
 * fix/h1-state-sync-autorefresh: `console.debug` traces so PO can open
 * DevTools (verbose) and verify the producer side actually fires. If
 * the trace is missing, the producer never invoked notifyStateChanged
 * (look at the call site). If the trace appears but the badge doesn't
 * refresh, the listener side is broken (see `useStateChange`).
 */
export function notifyStateChanged(
  reason: SyncReason,
  payload?: unknown,
): void {
  if (typeof window === 'undefined') return;
  const detail: SyncEventPayload = { reason, payload };
  // PO trace — visible in browser DevTools console (verbose level).
  // eslint-disable-next-line no-console
  console.debug('[lucid:sync] notify FIRE', reason, payload);
  try {
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }));
  } catch {
    // ignore — CustomEvent unsupported is rare enough we accept the gap
  }
  const bc = safeChannel();
  if (bc) {
    try {
      bc.postMessage(detail);
    } catch {
      // ignore — BroadcastChannel failure is non-fatal
    } finally {
      try {
        bc.close();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Subscribe to state-change events for the lifetime of a component.
 * The handler receives the SyncEventPayload regardless of whether it
 * arrived through the window event or the BroadcastChannel — callers
 * can branch on `reason` to decide whether to refetch.
 */
export function useStateChange(
  handler: (event: SyncEventPayload) => void,
): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onEvent = (e: Event) => {
      const ce = e as CustomEvent<SyncEventPayload>;
      if (ce.detail) {
        // PO trace — same-tab listener received the event.
        // eslint-disable-next-line no-console
        console.debug('[lucid:sync] LISTEN same-tab', ce.detail.reason);
        handler(ce.detail);
      }
    };
    window.addEventListener(SYNC_EVENT, onEvent as EventListener);

    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        bc = new BroadcastChannel(SYNC_CHANNEL);
        bc.onmessage = (e: MessageEvent) => {
          const data = e.data as SyncEventPayload | undefined;
          if (data) {
            // PO trace — cross-tab listener received the event.
            // eslint-disable-next-line no-console
            console.debug('[lucid:sync] LISTEN cross-tab', data.reason);
            handler(data);
          }
        };
      } catch {
        bc = null;
      }
    }

    return () => {
      window.removeEventListener(SYNC_EVENT, onEvent as EventListener);
      if (bc) {
        try {
          bc.close();
        } catch {
          // ignore
        }
      }
    };
  }, [handler]);
}

// Test surface — vitest doesn't have a BroadcastChannel by default;
// expose the constants so the test can stub it in and assert payloads.
export const __test__ = { SYNC_EVENT, SYNC_CHANNEL };
