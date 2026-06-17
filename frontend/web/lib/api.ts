/**
 * API client — wraps fetch with the JWT Authorization header.
 */
import { getToken, clearToken } from './auth';
import type {
  DecideRequest,
  DecideResponse,
  GraphNote,
  KnowledgeSpacePublic,
  LoginRequest,
  LoginResponse,
  PendingJobDetail,
  PendingListFilters,
  PendingPage,
  RecallResponse,
} from './types';

// Client-side fetch only — lib/api is imported by use-client components.
// SSR fetches live in lib/server-fetch which has the INTERNAL_API_URL branch.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

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

// ---------------------------------------------------------------------------
// Sprint 4A PR-4A-2 — Auth, Pending list, Graph notes
// ---------------------------------------------------------------------------

export function loginUser(payload: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getMySpaces(): Promise<KnowledgeSpacePublic[]> {
  return request<KnowledgeSpacePublic[]>('/api/spaces/me');
}

function buildPendingQuery(filters: PendingListFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listPending(
  spaceId: string,
  filters: PendingListFilters = {},
): Promise<PendingPage> {
  return request<PendingPage>(
    `/api/spaces/${spaceId}/pending${buildPendingQuery(filters)}`,
  );
}

export function listNotes(spaceId: string, factUid: string): Promise<GraphNote[]> {
  return request<GraphNote[]>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}/notes`,
  );
}

export function createNote(
  spaceId: string,
  factUid: string,
  note: string,
): Promise<GraphNote> {
  return request<GraphNote>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}/notes`,
    { method: 'POST', body: JSON.stringify({ note }) },
  );
}

export function deleteNote(
  spaceId: string,
  factUid: string,
  noteId: string,
): Promise<void> {
  return request<void>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}/notes/${noteId}`,
    { method: 'DELETE' },
  );
}

export function recall(
  spaceId: string,
  q: string,
  options: { limit?: number; entity?: string[] } = {},
): Promise<RecallResponse> {
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('limit', String(options.limit ?? 10));
  for (const uid of options.entity ?? []) {
    params.append('entity', uid);
  }
  return request<RecallResponse>(
    `/api/spaces/${spaceId}/recall?${params.toString()}`,
  );
}
