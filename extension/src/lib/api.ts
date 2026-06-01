/**
 * /api/capture wrapper. Service worker calls this on every "Save" message.
 */

import { getAuth } from './auth';

export const API_BASE = 'http://localhost:8000';

export interface CaptureRequest {
  source_url: string;
  source_type: 'web_article' | 'highlighted_text' | 'youtube' | 'pdf' | 'image';
  captured_from: 'chrome_ext';
  raw_payload_b64?: string;
  client_metadata?: Record<string, unknown>;
}

export interface CaptureResponse {
  job_id: string;
  status_url: string;
  status: string;
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
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return (await resp.json()) as CaptureResponse;
}
