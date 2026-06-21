/**
 * API client — wraps fetch with the JWT Authorization header.
 */
import { getToken, clearToken } from './auth';
import type {
  DecideRequest,
  DecideResponse,
  FactDetailResponse,
  FactMutationResponse,
  FactsList,
  GraphNote,
  HomeBrief,
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

// ---------------------------------------------------------------------------
// B-61 — multi-user gate: logout, /me
// (B-61-fix-admission removed registerUser / RegisterRequest /
//  RegisterResponse — admins now admit users via /api/admin/applications.)
// ---------------------------------------------------------------------------

export async function logoutUser(): Promise<void> {
  // Best-effort: JWT is stateless, so a network failure or 401 here is
  // fine — the SPA still clears the local token via clearToken(). The
  // backend call exists so the server can log the event and so the
  // future denylist (Phase 1+) has a place to record the JTI.
  try {
    await request<void>('/api/auth/logout', { method: 'POST' });
  } catch {
    // swallow — never let logout fail to clear local state.
  }
}

export type MeResponse = {
  user_id: string;
  email: string;
  display_name?: string | null;
  default_space_id?: string | null;
  is_new_user: boolean;
  is_admin: boolean;
};

export function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me', { method: 'GET' });
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

export interface RecallOptions {
  limit?: number;
  entity?: string[];
  // B-50 controls — all additive; omitting any preserves prior behaviour.
  scoreThreshold?: number;
  dateFrom?: string;  // ISO 8601
  dateTo?: string;    // ISO 8601
  // B-50-fix (PO A direction): matchKinds is a display-side filter
  // only. The recall API does NOT receive it — embedding is always
  // the seed; entity-link expansion always runs.
}

export function recall(
  spaceId: string,
  q: string,
  options: RecallOptions = {},
): Promise<RecallResponse> {
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('limit', String(options.limit ?? 10));
  for (const uid of options.entity ?? []) {
    params.append('entity', uid);
  }
  if (options.scoreThreshold !== undefined) {
    params.set('score_threshold', String(options.scoreThreshold));
  }
  if (options.dateFrom) {
    params.set('date_from', options.dateFrom);
  }
  if (options.dateTo) {
    params.set('date_to', options.dateTo);
  }
  return request<RecallResponse>(
    `/api/spaces/${spaceId}/recall?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// B-62 — facts listing (Stellar real-mode).
//
// Plain "give me every validated fact in this KS" — not the keyword-
// matched recall endpoint, so the Stellar real adapter can surface ALL
// the user's facts, not just the ones a generic seed query happens to
// hit. Server caps at 500; default 200.
// ---------------------------------------------------------------------------

export function listSpaceFacts(
  spaceId: string,
  limit = 200,
): Promise<FactsList> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  return request<FactsList>(
    `/api/spaces/${spaceId}/facts?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// B-48b — fact detail + retract / restore / detach-source
// ---------------------------------------------------------------------------

export function getFactDetail(
  spaceId: string, factUid: string,
): Promise<FactDetailResponse> {
  return request<FactDetailResponse>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}`,
  );
}

export function retractFact(
  spaceId: string, factUid: string,
): Promise<FactMutationResponse> {
  return request<FactMutationResponse>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}/retract`,
    { method: 'POST' },
  );
}

export function restoreFact(
  spaceId: string, factUid: string,
): Promise<FactMutationResponse> {
  return request<FactMutationResponse>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}/restore`,
    { method: 'POST' },
  );
}

export function detachSource(
  spaceId: string, factUid: string, sourceUid: string,
): Promise<FactMutationResponse> {
  return request<FactMutationResponse>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}/detach-source`,
    { method: 'POST', body: JSON.stringify({ source_uid: sourceUid }) },
  );
}

// ---------------------------------------------------------------------------
// B-55 / B-57 — home brief (fail-soft on the caller side; this just hits the
// endpoint and lets the caller catch). Wired by the app shell's nav badge.
// ---------------------------------------------------------------------------

export function getHomeBrief(): Promise<HomeBrief> {
  return request<HomeBrief>('/api/home/brief');
}

// ---------------------------------------------------------------------------
// B-61-fix-admission — admin admission endpoints
// ---------------------------------------------------------------------------

export type ApplicationListItem = {
  application_id: string;
  email: string;
  profession: string | null;
  q1: string | null;
  q2: string | null;
  lang: string | null;
  status: string;
  created_at: string | null;
};

export type ApplicationsListResponse = {
  items: ApplicationListItem[];
  total: number;
};

export type ApproveResponse = {
  application_id: string;
  user_id: string;
  email: string;
  temp_password: string;
  already_existed: boolean;
  status: string;
};

export function listApplications(
  statusFilter: 'pending' | 'approved' | 'rejected' | 'all' = 'pending',
): Promise<ApplicationsListResponse> {
  const params = new URLSearchParams();
  params.set('status', statusFilter);
  return request<ApplicationsListResponse>(
    `/api/admin/applications?${params.toString()}`,
  );
}

export function approveApplication(id: string): Promise<ApproveResponse> {
  return request<ApproveResponse>(
    `/api/admin/applications/${encodeURIComponent(id)}/approve`,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------------------
// M4a — assistant brief
// ---------------------------------------------------------------------------

export function postAssistantBrief(
  query: string,
  spaceId: string,
): Promise<import('./types').AssistantBriefResponse> {
  return request<import('./types').AssistantBriefResponse>('/api/assistant/brief', {
    method: 'POST',
    body: JSON.stringify({ query, space_id: spaceId }),
  });
}
