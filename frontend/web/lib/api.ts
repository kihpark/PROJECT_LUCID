/**
 * API client — wraps fetch with the JWT Authorization header.
 */
import { getToken, clearToken } from './auth';
import type {
  DecideRequest,
  DecideResponse,
  EntitySuggestion,
  FactDetailResponse,
  FactMutationResponse,
  FactsList,
  GraphNote,
  HomeBrief,
  KnowledgeSpacePublic,
  LedgerResponse,
  LoginRequest,
  LoginResponse,
  ModifyFactRequest,
  PendingJobDetail,
  PendingListFilters,
  PendingPage,
  PredicateEntry,
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

  // fix/h1-state-sync-autorefresh: belt-and-suspenders cache defeat.
  // The backend's /api/home/brief already returns Cache-Control:
  // no-store (api/routes/home.py) — but if the caller passes their own
  // init.cache we honor it, otherwise default to 'no-store' so a stale
  // browser HTTP cache cannot stand in for a fresh post-validate read.
  const finalInit: RequestInit = {
    ...init,
    headers,
    cache: init.cache ?? 'no-store',
  };

  const resp = await fetch(`${API_BASE}${path}`, finalInit);

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
// fix/r1-recall-redesign — AI 브리핑 (entity 개관).
//
// Distinct from /api/assistant/brief (ORACLE — question answering).
// This is an on-demand overview of the CURRENT recall result set:
// "what does the user already know about this entity?". The button
// is rendered inside the RecallFactTypeSummary box; clicking it fires
// this call which re-runs recall server-side and feeds the verified
// facts to Claude with the 개관 system prompt.
//
// Cost guard: on-demand only (the user must click), and the server
// caches the (space, query, entities, fact_uids) → response for 30
// minutes so a repeat click is free.
// ---------------------------------------------------------------------------

export interface RecallBriefingResponse {
  briefing: string;
  fact_uids: string[];
  grounded: boolean;
  cached: boolean;
  fact_count: number;
}

export function recallBriefing(
  spaceId: string,
  q: string,
  entities: string[] = [],
): Promise<RecallBriefingResponse> {
  const params = new URLSearchParams();
  params.set('q', q);
  for (const uid of entities) {
    params.append('entity', uid);
  }
  return request<RecallBriefingResponse>(
    `/api/spaces/${spaceId}/recall/briefing?${params.toString()}`,
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
// feat/ledger-view — LEDGER (제3의 뷰).
//
// Chronological list of recently validated facts. Paged with
// limit (default 20, max 100) + offset; optional fact_type chip.
// The "load more" pattern: caller supplies offset=facts.length and
// appends the returned page to the existing list.
// ---------------------------------------------------------------------------

export interface LedgerOptions {
  limit?: number;
  offset?: number;
  factType?: 'action' | 'claim' | 'measurement' | null;
}

export function fetchLedger(
  spaceId: string,
  options: LedgerOptions = {},
): Promise<LedgerResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 20));
  params.set('offset', String(options.offset ?? 0));
  if (options.factType) {
    params.set('fact_type', options.factType);
  }
  return request<LedgerResponse>(
    `/api/spaces/${spaceId}/ledger?${params.toString()}`,
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

// feat/fact-detail-modify — PATCH surface fields of a validated fact.
// Returns the refreshed FactDetailResponse so the caller can swap the
// modal state without a second GET round-trip.
export function modifyFact(
  spaceId: string, factUid: string, payload: ModifyFactRequest,
): Promise<FactDetailResponse> {
  return request<FactDetailResponse>(
    `/api/spaces/${spaceId}/facts/${encodeURIComponent(factUid)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
}

// ---------------------------------------------------------------------------
// B-55 / B-57 — home brief (fail-soft on the caller side; this just hits the
// endpoint and lets the caller catch). Wired by the app shell's nav badge.
// ---------------------------------------------------------------------------

export function getHomeBrief(): Promise<HomeBrief> {
  // fix/h1-state-sync-autorefresh: cache-buster query param. The browser
  // ignores it; the backend ignores it (no Query() parameter named `_`);
  // but a unique URL forces past any intermediary that might otherwise
  // serve a cached body (service worker, CDN edge, broken proxy). This
  // is the last line of defense if Cache-Control: no-store somehow
  // gets stripped before reaching the browser.
  const cacheBuster = Date.now();
  return request<HomeBrief>(`/api/home/brief?_=${cacheBuster}`);
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

// ---------------------------------------------------------------------------
// spo-pending-ux — entity suggestion + predicate autocomplete
// ---------------------------------------------------------------------------

/**
 * ★ fix/entitycard-fact-count-and-dot-suggestion — entity suggestion guard.
 *
 * Backend `backend/api/routes/entities.py::suggest_entities` only filters
 * empty `name` strings — a stray "." (or other punctuation-only label that
 * upstream extraction treated as an entity) survives and can rank high in
 * `match_phrase_prefix` due to low IDF. Frontend renders the dropdown verbatim,
 * so the user sees a "." item that returns nothing on click.
 *
 * Filter sits at the api layer (NOT backend, per PO frontend-only constraint)
 * so BOTH RecallView and FactCard get the protection automatically. Exported
 * for unit tests.
 */
export function isMeaningfulLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  const trimmed = label.trim();
  if (!trimmed) return false;
  // Strip common punctuation; require at least one alphanumeric /
  // hangul / kana / CJK character. \p{L} = letter, \p{N} = number.
  return /[\p{L}\p{N}]/u.test(trimmed);
}

export function searchEntitySuggestions(
  q: string,
  spaceId: string,
  limit = 5,
): Promise<EntitySuggestion[]> {
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('limit', String(limit));
  return request<{ items: EntitySuggestion[] }>(
    `/api/spaces/${spaceId}/entities/suggest?${params.toString()}`,
  ).then((r) => r.items.filter((s) => isMeaningfulLabel(s.primary_label)));
}

// ───────────────────────────────────────────────────────────────────
// REQ-012-v1 — entity 종류 수정 + 노드 합치기 + 분리.
// ───────────────────────────────────────────────────────────────────

/** ★ PO 의뢰서 verbatim: 10종 closed set.
 *  resolution_gateway.ENTITY_TYPE_V3 와 동일. */
export const ENTITY_TYPE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: 'person', label: '사람' },
  { value: 'organization', label: '조직' },
  { value: 'group', label: '그룹' },
  { value: 'knowledge', label: '지식' },
  { value: 'resource', label: '자원' },
  { value: 'task', label: '행위' },
  { value: 'concept', label: '개념' },
  { value: 'event', label: '사건' },
  { value: 'metric', label: '지표' },
  { value: 'location', label: '장소' },
];

export interface EntityTypeChangeResult {
  entity_uid: string;
  primary_label: string;
  previous_entity_type: string | null;
  entity_type: string;
  relabel_history_size: number;
  updated_at: string;
}

/** REQ-012-v1 기능 A — entity 종류 변경. closed 10-set 검증은 server-side. */
export function changeEntityType(
  spaceId: string,
  entityUid: string,
  entityType: string,
  reason?: string,
): Promise<EntityTypeChangeResult> {
  return request<EntityTypeChangeResult>(
    `/api/spaces/${spaceId}/entities/${encodeURIComponent(entityUid)}/type`,
    {
      method: 'POST',
      body: JSON.stringify({ entity_type: entityType, reason: reason ?? null }),
    },
  );
}

export interface MergeCandidate {
  entity_uid: string;
  primary_label: string;
  entity_type: string | null;
  score: number;
  reason: string;
}

/** REQ-012-v1 기능 B 후보 제시. */
export function fetchMergeCandidates(
  spaceId: string,
  entityUid: string,
  limit = 10,
): Promise<MergeCandidate[]> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  return request<{ items: MergeCandidate[] }>(
    `/api/spaces/${spaceId}/entities/${encodeURIComponent(entityUid)}/merge-candidates?${params.toString()}`,
  ).then((r) => r.items);
}

export interface EntityMergeResult {
  canonical_uid: string;
  primary_label: string;
  entity_type: string;
  aliases: string[];
  members_retired: string[];
  facts_rewritten: {
    subjects_remapped: number;
    objects_remapped: number;
    facts_touched: number;
  };
  merged_at: string;
}

/** REQ-012-v1 기능 B — 사용자 수동 병합. */
export function mergeEntities(
  spaceId: string,
  canonicalUid: string,
  members: string[],
  opts?: { primaryLabel?: string; reason?: string },
): Promise<EntityMergeResult> {
  return request<EntityMergeResult>(
    `/api/spaces/${spaceId}/entities/merge`,
    {
      method: 'POST',
      body: JSON.stringify({
        canonical_uid: canonicalUid,
        members,
        primary_label: opts?.primaryLabel ?? null,
        reason: opts?.reason ?? null,
      }),
    },
  );
}

export interface EntityUnmergeResult {
  canonical_uid: string;
  members_restored: string[];
  aliases_after: string[];
  facts_reverted: {
    subjects_reverted: number;
    objects_reverted: number;
    facts_touched: number;
  };
  unmerged_at: string;
}

/** REQ-012-v1 기능 B 되돌리기 — 가장 최근 user_merge 한 그룹 복원. */
export function unmergeEntity(
  spaceId: string,
  canonicalUid: string,
  reason?: string,
): Promise<EntityUnmergeResult> {
  return request<EntityUnmergeResult>(
    `/api/spaces/${spaceId}/entities/unmerge`,
    {
      method: 'POST',
      body: JSON.stringify({
        canonical_uid: canonicalUid,
        reason: reason ?? null,
      }),
    },
  );
}

// ───────────────────────────────────────────────────────────────────
// REQ-012-v2 (PO 2026-07-01, image #145 dogfood) — name edit + delete.
// ───────────────────────────────────────────────────────────────────

export interface EntityNameChangeResult {
  entity_uid: string;
  primary_label: string;
  previous_name: string | null;
  aliases: string[];
  relabel_history_size: number;
  updated_at: string;
}

/** REQ-012-v2 — entity 대표명 변경. 옛 이름은 aliases 로 흡수 (server-side). */
export function updateEntityName(
  spaceId: string,
  entityUid: string,
  name: string,
  opts?: { previousName?: string; reason?: string },
): Promise<EntityNameChangeResult> {
  return request<EntityNameChangeResult>(
    `/api/spaces/${spaceId}/entities/${encodeURIComponent(entityUid)}/name`,
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        previous_name: opts?.previousName ?? null,
        reason: opts?.reason ?? null,
      }),
    },
  );
}

export interface EntityDeleteResult {
  entity_uid: string;
  primary_label: string;
  retired_at: string;
  facts_retracted: number;
}

/** REQ-012-v2 — entity soft delete. 연결 fact 는 자동 retract. */
export function deleteEntity(
  spaceId: string,
  entityUid: string,
  reason?: string,
): Promise<EntityDeleteResult> {
  return request<EntityDeleteResult>(
    `/api/spaces/${spaceId}/entities/${encodeURIComponent(entityUid)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ reason: reason ?? null }),
    },
  );
}

/** REQ-012-v2 — fact soft delete alias. 옛 B-48b retractFact 재사용
 *  (retracted_at 세팅 = 소프트 삭제). 이름만 사용자 mental model 에 맞게. */
export function deleteFact(
  spaceId: string,
  factUid: string,
): Promise<FactMutationResponse> {
  return retractFact(spaceId, factUid);
}

// Module-level predicate cache — predicates are global vocabulary that
// rarely change. First call fetches; subsequent calls return the same
// promise so only one in-flight request is ever made even if the component
// mounts multiple times.
let _predicateCache: PredicateEntry[] | null = null;
let _predicateFetch: Promise<PredicateEntry[]> | null = null;

export function listPredicates(): Promise<PredicateEntry[]> {
  if (_predicateCache !== null) {
    return Promise.resolve(_predicateCache);
  }
  if (_predicateFetch !== null) {
    return _predicateFetch;
  }
  _predicateFetch = request<{ items: PredicateEntry[] }>('/api/predicates').then(
    (r) => {
      _predicateCache = r.items;
      _predicateFetch = null;
      return r.items;
    },
  );
  return _predicateFetch;
}
