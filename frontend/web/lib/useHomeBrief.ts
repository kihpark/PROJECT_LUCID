/**
 * useHomeBrief — fetches GET /api/home/brief (B-55) on mount and exposes the
 * payload + a pendingCount convenience. Fail-soft: if the endpoint isn't
 * wired yet (404) or the request rejects, brief stays null and pendingCount
 * is 0 so the nav badge collapses to plain "검증".
 *
 * The hook intentionally does NO retries, no polling, no auth gating. The
 * shell renders on every page; a failed fetch must never crash navigation.
 */
'use client';

import { useEffect, useState } from 'react';
import { getHomeBrief } from './api';
import type { HomeBrief } from './types';

export interface UseHomeBriefResult {
  brief: HomeBrief | null;
  pendingCount: number;
}

export function useHomeBrief(): UseHomeBriefResult {
  const [brief, setBrief] = useState<HomeBrief | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHomeBrief()
      .then((b) => {
        if (!cancelled) setBrief(b);
      })
      .catch(() => {
        // Fail-soft: B-55 may not be merged yet, or the user may be unauth.
        // Either way, no badge — never crash the shell.
        if (!cancelled) setBrief(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingCount = brief?.pending_validation ?? 0;
  return { brief, pendingCount };
}
