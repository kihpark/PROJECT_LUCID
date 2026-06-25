/**
 * useHomeBrief — fetches GET /api/home/brief (B-55) on mount and
 * re-fetches in response to any cross-component state-change event
 * (feat/state-sync-unification).
 *
 * Fail-soft: if the endpoint isn't wired (404) or the request rejects,
 * brief stays null and pendingCount is 0 so the nav badge collapses.
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
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getHomeBrief()
      .then((b) => {
        if (!cancelled) setBrief(b);
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

  const pendingCount = brief?.pending_validation ?? 0;
  return { brief, pendingCount, refetch };
}
