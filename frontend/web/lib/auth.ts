/**
 * JWT auth — beta-grade. Token lives in localStorage; middleware
 * reads it from a cookie mirror so server-side gating works too.
 *
 * Phase 1+ swap: httpOnly cookies + refresh-token rotation.
 */

const TOKEN_KEY = 'lucid_jwt';
const COOKIE_NAME = 'lucid_jwt';

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
  // Mirror into a cookie so middleware (server-side) can gate routes.
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  document.cookie = `${COOKIE_NAME}=; path=/; Max-Age=0; SameSite=Lax`;
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

// ---------------------------------------------------------------------------
// Sprint 4A PR-4A-2 — Current KnowledgeSpace mirror cookie
// ---------------------------------------------------------------------------
const SPACE_COOKIE = 'lucid_space_id';
const SPACE_KEY = 'lucid_space_id';

export function setCurrentSpace(spaceId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SPACE_KEY, spaceId);
  document.cookie = `${SPACE_COOKIE}=${encodeURIComponent(spaceId)}; path=/; SameSite=Lax`;
}

export function getCurrentSpace(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SPACE_KEY);
}

export function clearCurrentSpace(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SPACE_KEY);
  document.cookie = `${SPACE_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`;
}
