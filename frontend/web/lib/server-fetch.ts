/**
 * Shared SSR fetch helper for `/pending/[jobId]` and
 * `/pending/[jobId]/review` (and any future server component that
 * needs to call the backend with the user's Bearer token).
 *
 * Why a helper:
 *   - Surface undici's `error.cause` so opaque "fetch failed" messages
 *     become actionable (`ECONNREFUSED 127.0.0.1:8000`, etc).
 *   - Echo the failed URL + error code to the server console so the
 *     `pnpm dev` terminal carries the diagnostic.
 *   - Provide one place to swap localhost->container hostname when
 *     this code starts running in the docker web service.
 */

export interface ServerFetchError extends Error {
  url: string;
  apiBase: string;
  causeCode?: string;
}

export function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
}

interface FetchOpts {
  token: string;
  method?: 'GET' | 'POST' | 'DELETE';
}

function describeCause(err: unknown): { code?: string; message: string } {
  const node = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  const code = node?.code ?? node?.cause?.code;
  const causeMsg = node?.cause?.message;
  if (code) {
    return { code, message: causeMsg ?? node.message ?? String(err) };
  }
  return { message: causeMsg ?? node?.message ?? String(err) };
}

export async function ssrJson<T>(path: string, opts: FetchOpts): Promise<T | null> {
  const base = apiBase();
  const url = `${base}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
  } catch (err) {
    const { code, message } = describeCause(err);
    // Log to the server console so it shows up in `pnpm dev`.
    console.error(
      `[ssr-fetch] FAIL ${opts.method ?? 'GET'} ${url}`,
      code ? `(${code})` : '',
      message,
    );
    const wrapped = new Error(
      code
        ? `Could not reach API (${code}). Tried ${url}.`
        : `Could not reach API. Tried ${url}. ${message}`,
    ) as ServerFetchError;
    wrapped.url = url;
    wrapped.apiBase = base;
    wrapped.causeCode = code;
    throw wrapped;
  }
  if (resp.status === 404) return null;
  if (resp.status === 401 || resp.status === 403) {
    // Treat auth failure as "go sign in again" rather than a generic 500.
    const wrapped = new Error(
      `API rejected the session (HTTP ${resp.status}). Sign in again.`,
    ) as ServerFetchError;
    wrapped.url = url;
    wrapped.apiBase = base;
    throw wrapped;
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      if (typeof body?.detail === 'string') detail = ` — ${body.detail}`;
    } catch {
      // ignore JSON parse errors on the error response
    }
    const wrapped = new Error(
      `API returned HTTP ${resp.status} for ${url}${detail}.`,
    ) as ServerFetchError;
    wrapped.url = url;
    wrapped.apiBase = base;
    throw wrapped;
  }
  return (await resp.json()) as T;
}
