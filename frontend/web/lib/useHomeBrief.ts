/**
 * useHomeBrief — fetches GET /api/home/brief (B-55) on mount and
 * re-fetches in response to any cross-component state-change event
 * (feat/state-sync-unification).
 *
 * Fail-soft: if the endpoint isn't wired (404) or the request rejects,
 * brief stays null and pendingCount is 0 so the nav badge collapses.
 *
 * ★ V1 (HOME sync 위반 클래스, 2026-06-29) — also re-fetches on tab
 *   `visibilitychange` (→ visible) and `window` `focus`. PO principle:
 *   "사용자 행위 후 페이지 stale 0" — when the user captures/validates
 *   in another tab and returns to HOME, the brief must auto-refresh
 *   without a manual Ctrl+Shift+R.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { getHomeBrief } from './api';
import { useStateChange } from './sync';
import type { HomeBrief } from './types';

export interface UseHomeBriefResult {
  brief: HomeBrief | null;
  pendingCount: number;
  refetch: () => void;
}

export function useHomeBrief(): UseHomeBriefResult {
  const [brief, setBrief] = useState<HomeBrief | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    // PO trace — `tick` bumps trigger the effect below to fire a new
    // /api/home/brief request. If you see "refetch" but no network
    // request in DevTools Network panel, the effect didn't observe the
    // tick change (closure problem). If you see the request but the
    // badge doesn't update, the response was the same (backend stale).
    // eslint-disable-next-line no-console
    console.debug('[useHomeBrief] refetch bump');
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-console
    console.debug('[useHomeBrief] fetch tick=', tick);
    getHomeBrief()
      .then((b) => {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.debug(
            '[useHomeBrief] fetched pending_validation=',
            b?.pending_validation,
          );
          setBrief(b);
        }
      })
      .catch(() => {
        if (!cancelled) setBrief(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useStateChange(
    useCallback(
      (e) => {
        // Any state-change reason invalidates the brief — the brief
        // aggregates totals across the whole KS so a single capture
        // or retract can move any of its numbers.
        void e;
        refetch();
      },
      [refetch],
    ),
  );

  // ★ V1 — visibilitychange refetch. When the user returns to this tab
  // after acting elsewhere (capture/validate in another tab, browser
  // window minimised then restored), the brief is auto-refreshed so
  // they never see stale numbers.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handler = () => {
      if (document.visibilityState === 'visible') {
        // eslint-disable-next-line no-console
        console.debug('[useHomeBrief] visibility refetch');
        refetch();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
    };
  }, [refetch]);

  // ★ V1 — window focus refetch. Covers the case where the OS-level
  // window regains focus (alt-tab back to the browser) — some browsers
  // only fire 'focus', not 'visibilitychange', in that path.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      // eslint-disable-next-line no-console
      console.debug('[useHomeBrief] focus refetch');
      refetch();
    };
    window.addEventListener('focus', handler);
    return () => {
      window.removeEventListener('focus', handler);
    };
  }, [refetch]);

  const pendingCount = brief?.pending_validation ?? 0;
  return { brief, pendingCount, refetch };
}
