/**
 * B-61 — useAuthMe hook.
 *
 * Lazily loads the caller's identity + cold-start signal from
 * GET /api/auth/me on mount. Short-circuits when there is no token
 * so the login/register surfaces never fire a useless fetch that
 * would 401 + clear nothing (clearToken is already idempotent).
 *
 * Returns { me, loading, error }. The consumer decides what to do
 * with `loading`/`error` — AppShell falls back to the hardcoded
 * defaults until `me` lands; HomePage hides the welcome line until
 * `me.is_new_user === true`.
 */
'use client';

import { useEffect, useState } from 'react';
import { getMe, type MeResponse } from './api';
import { isAuthenticated } from './auth';

export type AuthMeState = {
  me: MeResponse | null;
  loading: boolean;
  error: Error | null;
};

export function useAuthMe(): AuthMeState {
  const [state, setState] = useState<AuthMeState>({
    me: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!isAuthenticated()) {
      setState({ me: null, loading: false, error: null });
      return;
    }
    getMe()
      .then((me) => {
        if (!cancelled) setState({ me, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ me: null, loading: false, error: err as Error });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
