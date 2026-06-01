/**
 * API client — wraps fetch with the JWT Authorization header.
 */
import { getToken, clearToken } from './auth';
import type {
  DecideRequest,
  DecideResponse,
  PendingJobDetail,
} from './types';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8000');

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const resp = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (!resp.ok) {
    if (resp.status === 401) {
      clearToken();
    }
    let detail: string | undefined;
    try {
      const body = await resp.json();
      detail = typeof body?.detail === 'string' ? body.detail : undefined;
    } catch {
      // ignore JSON parse failure
    }
    throw new ApiError(
      `API ${resp.status} on ${path}`,
      resp.status,
      detail,
    );
  }

  if (resp.status === 204) {
    return undefined as T;
  }
  return (await resp.json()) as T;
}

export function getPendingDetail(
  spaceId: string,
  jobId: string,
): Promise<PendingJobDetail> {
  return request<PendingJobDetail>(
    `/api/spaces/${spaceId}/pending/${jobId}`,
  );
}

export function submitDecisions(
  spaceId: string,
  jobId: string,
  payload: DecideRequest,
): Promise<DecideResponse> {
  return request<DecideResponse>(
    `/api/spaces/${spaceId}/pending/${jobId}/decide`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export function acceptAll(
  spaceId: string,
  jobId: string,
): Promise<DecideResponse> {
  return request<DecideResponse>(
    `/api/spaces/${spaceId}/pending/${jobId}/accept-all`,
    { method: 'POST' },
  );
}

export function discardJob(
  spaceId: string,
  jobId: string,
): Promise<DecideResponse> {
  return request<DecideResponse>(
    `/api/spaces/${spaceId}/pending/${jobId}/discard`,
    { method: 'POST' },
  );
}
