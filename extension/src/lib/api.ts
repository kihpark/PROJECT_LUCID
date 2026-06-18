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
