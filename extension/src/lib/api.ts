/**
 * /api/capture wrapper. Service worker calls this on every "Save" message.
 */

import { getAuth } from './auth';

export const API_BASE = 'http://localhost:8000';

export interface CaptureRequest {
  source_url: string;
  // B-45: image captures use 'page_image' (matches backend SourceType
  // enum). The legacy 'image' string is gone — it never matched the
  // backend enum and silently 422'd.
  source_type: 'web_article' | 'highlighted_text' | 'youtube' | 'pdf' | 'page_image';
  captured_from: 'chrome_ext';
  raw_payload_b64?: string;
  client_metadata?: Record<string, unknown>;
}

export interface CaptureResponse {
  job_id: string;
  status_url: string;
  status: string;
}

/**
 * B-45-fix: render a backend error body into a single readable line
 * regardless of its shape.
 *
 * Cases observed in production:
 *   - {detail: "not_authenticated"}              (string)
 *   - {detail: [{loc:[...], msg:"...", type:..}]} (Pydantic 422 array)
 *   - {detail: {something:"...", ...}}            (arbitrary object)
 *
 * The pre-fix code did `String(body.detail)` which on the 422 array
 * shape rendered "[object Object]" — utterly useless to the user.
 */
export function describeApiError(body: unknown, fallback: string): string {
  if (body === null || body === undefined) return fallback;
  if (typeof body === 'string') return body;
  if (typeof body !== 'object') return String(body);
  const detail = (body as { detail?: unknown }).detail;
  if (detail === undefined || detail === null) return fallback;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // Pydantic 422: each entry has `msg` + `loc`. Render the first
    // (most-actionable) one with its location path.
    const first = detail[0] as { msg?: string; loc?: unknown[] } | undefined;
    if (first && typeof first === 'object') {
      const msg = typeof first.msg === 'string' ? first.msg : JSON.stringify(first);
      const loc = Array.isArray(first.loc) ? first.loc.join('.') : '';
      return loc ? `${msg} (${loc})` : msg;
    }
  }
  // Any other object — JSON.stringify is the honest fallback. Better
  // a noisy line than the silent "[object Object]" misdirection.
  try {
    return JSON.stringify(detail);
  } catch {
    return fallback;
  }
}

export async function postCapture(
  payload: CaptureRequest,
): Promise<CaptureResponse> {
  const auth = await getAuth();
  if (!auth) {
    throw new Error('not_authenticated');
  }
  // The space_id moves on the URL prefix per Sprint 1B routing.
  const resp = await fetch(`${API_BASE}/api/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const fallback = `HTTP ${resp.status}`;
    let detail = fallback;
    try {
      const body = await resp.json();
      detail = describeApiError(body, fallback);
    } catch {
      // JSON body unavailable; keep the HTTP status as the message.
    }
    throw new Error(detail);
  }
  return (await resp.json()) as CaptureResponse;
}

export interface JobStatusResponse {
  job_id: string;
  knowledge_space_id: string;
  source_url: string;
  source_type: string;
  status: string;
  captured_at: string;
  captured_from: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const auth = await getAuth();
  if (!auth) throw new Error('not_authenticated');
  const resp = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return (await resp.json()) as JobStatusResponse;
}

/**
 * fix/popup-polling-status-recover — server-truth status lookup for the
 * popup's force-refresh flow.
 *
 * Why a parallel function instead of using `getJobStatus`?
 * The /api/jobs/{job_id} response is parsed by FastAPI through the
 * Pydantic `JobStatusResponse` which validates `status` against the
 * `SourceStatus` StrEnum (see backend/api/models/source_job.py). The
 * enum is *missing* the terminal `validated` value (only present in the
 * DB CheckConstraint + ORM). When a job has been validated server-side,
 * the route raises a 500 — the very PO bug we are recovering from.
 * Until the backend enum is widened (out of scope here per the
 * implementation plan), the extension must treat that
 * 500-with-internal-error path as evidence-of-terminality, not as
 * "still inflight".
 *
 * Contract:
 *   - 200 -> returns { status, error_message } verbatim.
 *   - 401 -> throws `not_authenticated` so the SW surfaces the auth
 *     issue instead of optimistically marking done.
 *   - 403 -> throws `forbidden`.
 *   - 404 -> throws `job_not_found` so the SW can dismiss the local
 *     row (the server has no record).
 *   - 500 (or any other >=500) -> returns a synthetic
 *     `{ status: 'validated', error_message: null }` shape so the
 *     caller treats the job as terminal-completed. This is the
 *     workaround for the enum gap.
 *
 * The synthetic shape only carries `status` + `error_message` because
 * the SW handler only reads those fields. We intentionally do not
 * fabricate the rest of JobStatusResponse.
 */
export interface ServerJobStatus {
  status: string;
  error_message: string | null;
}

export async function fetchServerJobStatus(jobId: string): Promise<ServerJobStatus> {
  const auth = await getAuth();
  if (!auth) throw new Error('not_authenticated');
  const resp = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json',
    },
  });
  if (resp.ok) {
    const body = (await resp.json()) as JobStatusResponse;
    return {
      status: String(body.status),
      error_message: body.error_message ?? null,
    };
  }
  if (resp.status === 401) throw new Error('not_authenticated');
  if (resp.status === 403) throw new Error('forbidden');
  if (resp.status === 404) throw new Error('job_not_found');
  // >=500 -- almost certainly the SourceStatus enum gap for 'validated'.
  // Returning a synthetic terminal-completed status lets the popup
  // unstick the row without waiting on a backend deploy.
  if (resp.status >= 500) {
    return { status: 'validated', error_message: null };
  }
  // 4xx other than 401/403/404 -- propagate so we don't silently mark
  // a still-inflight row terminal.
  let detail = `HTTP ${resp.status}`;
  try {
    const body = await resp.json();
    if (body?.detail) detail = String(body.detail);
  } catch {
    // ignore
  }
  throw new Error(detail);
}

export interface StructuredSummary {
  fact_count: number;
  object_count: number;
  has_disambiguation: boolean;
}

export async function getStructuredSummary(jobId: string): Promise<StructuredSummary> {
  const auth = await getAuth();
  if (!auth) throw new Error('not_authenticated');
  const resp = await fetch(
    `${API_BASE}/api/spaces/${auth.spaceId}/pending/${jobId}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${auth.token}`,
        'Accept': 'application/json',
      },
    },
  );
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  const data = (await resp.json()) as {
    facts: unknown[];
    objects: unknown[];
    disambiguation_pending: unknown[];
  };
  return {
    fact_count: data.facts.length,
    object_count: data.objects.length,
    has_disambiguation: data.disambiguation_pending.length > 0,
  };
}

// ---------------------------------------------------------------------------
// B-58 — home brief read for the popup "오늘의 brief" block. Mirrors the web
// app's `getHomeBrief` (frontend/web/lib/api.ts) but lives here so the popup
// doesn't pull in next.js / SSR helpers. The shape is exactly what
// backend/api/routes/home.py returns. Fail-soft is the caller's contract:
// every reject collapses to the muted fallback line in the popup.
// ---------------------------------------------------------------------------

export interface HomeBriefRecentItem {
  fact_uid: string;
  claim: string;
  subject_label?: string | null;
  validated_at: string;
}

export interface HomeBriefTotals {
  facts: number;
  entities: number;
  sources: number;
  this_week_validated: number;
}

export interface HomeBriefCluster {
  entity_uid: string | null;
  entity_name: string | null;
  linked_count: number;
}

export interface HomeBrief {
  totals: HomeBriefTotals;
  pending_validation: number;
  recent_validated: HomeBriefRecentItem[];
  top_cluster: HomeBriefCluster | null;
  is_empty: boolean;
}

export async function getHomeBrief(): Promise<HomeBrief> {
  const auth = await getAuth();
  if (!auth) throw new Error('not_authenticated');
  const resp = await fetch(`${API_BASE}/api/home/brief`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      detail = describeApiError(body, detail);
    } catch {
      // ignore — keep the HTTP status
    }
    throw new Error(detail);
  }
  return (await resp.json()) as HomeBrief;
}
