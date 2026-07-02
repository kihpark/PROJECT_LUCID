/**
 * Pydantic-mirror types. Hand-kept in sync with backend/api/models/validate.py.
 *
 * If you change the backend shape, mirror it here. There is no codegen step
 * in beta — see DR-067 for the staging-in-JSONB pattern.
 */

export type FactAction = 'accept' | 'edit' | 'discard';
export type ObjectAction = 'create_new' | 'merge_with' | 'skip';

export interface FactSummary {
  fact_uid?: string;
  uid?: string;
  claim: string;
  claim_en?: string | null;
  type?: string;
  subject_uid?: string;
  predicate?: string;
  object_value?: string;
  negation_flag?: boolean;
  negation_scope?: 'full' | 'partial' | null;
  quantifier?: string | null;
  modal?: string | null;
  tags_suggested?: string[];
  // v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split. Null
  // / undefined on legacy facts — FactCard treats absence as 'action'.
  // v0.2.0 step 2 (fact-measurement-layer-v1): 3rd bucket adds metric /
  // value / unit / as_of for numeric facts pinned to a timepoint.
  fact_type?: 'action' | 'claim' | 'measurement' | null;
  speaker_uid?: string | null;
  speaker_label?: string | null;
  speech_act?: string | null;
  content_claim?: string | null;
  stance?: string | null;
  metric?: string | null;
  measurement_value?: number | null;
  measurement_unit?: string | null;
  as_of?: string | null;
}

export interface ObjectSummary {
  uid: string;
  class?: string;
  class_?: string;
  name: string;
  name_en?: string | null;
  properties?: Record<string, unknown>;
}

export interface DisambigCandidate {
  object_uid: string;
  name: string;
  object_class: string;
  score: number;
}

export interface DisambigEntry {
  disambig_id: string;
  job_id: string;
  candidate_name: string;
  decision_reason: string;
  candidates: DisambigCandidate[];
}

export interface PendingJobDetail {
  job_id: string;
  source_url: string;
  source_type: string;
  captured_at: string;
  captured_from: string;
  knowledge_space_id: string;
  extracted_text_preview: string;
  facts: FactSummary[];
  objects: ObjectSummary[];
  fact_object_links: unknown[];
  fact_fact_links: unknown[];
  disambiguation_pending: Array<{
    llm_uid: string;
    candidate_name: string;
    decision_reason: string;
    candidates: DisambigCandidate[];
  }>;
}

export interface FactDecision {
  fact_uid: string;
  action: FactAction;
  edited_claim?: string;
  edited_metadata?: Record<string, unknown>;
}

export interface ObjectDecision {
  candidate_id: string;
  action: ObjectAction;
  merge_target_uid?: string;
}

export interface DecideRequest {
  decisions: FactDecision[];
  object_decisions: ObjectDecision[];
}

export interface DecideResponse {
  accepted_facts: string[];
  edited_facts: string[];
  discarded_facts: string[];
  created_objects: string[];
  merged_objects: string[];
  skipped_objects: string[];
  validation_log_count: number;
}

// ---------------------------------------------------------------------------
// Sprint 4A PR-4A-2 — Pending Queue / Graph notes / Login
// ---------------------------------------------------------------------------

export interface PendingJobSummary {
  job_id: string;
  source_url: string;
  source_type: string;
  captured_at: string;
  captured_from: string;
  fact_count: number;
  object_count: number;
  has_negation: boolean;
  has_disambiguation: boolean;
  // pending-card-title-date: article headline + source hostname so the
  // card renders the human-readable title as the primary text instead
  // of the URL. Backend guarantees both are non-empty strings (it
  // falls back to the hostname / "(제목 없음)" when the article had
  // no usable <title>).
  title: string;
  hostname: string;
}

export interface PendingPage {
  items: PendingJobSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface PendingListFilters {
  source_url?: string;
  source_type?: string;
  captured_after?: string;
  captured_before?: string;
  has_negation_flag?: boolean;
  has_disambiguation?: boolean;
  offset?: number;
  limit?: number;
}

export interface GraphNote {
  id: string;
  fact_uid: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
}

export interface KnowledgeSpacePublic {
  id: string;
  type: string;
  name: string | null;
  user_id: string;
}

// ---------------------------------------------------------------------------
// B-25 / DR-089 — recall thin slice
// ---------------------------------------------------------------------------

export interface RecallFact {
  fact_uid: string;
  claim: string;
  claim_en: string | null;
  subject_uid: string;
  predicate: string;
  object_value: string;
  source_uids: string[];
  validated_at: string;
  validator_id: string;
  validation_method: 'manual';
  knowledge_space_id: string;
  negation_flag: boolean;
  negation_scope: 'full' | 'partial' | null;
  score: number;
  // B-25 stage 2 / B-35 wiring.
  // fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01):
  // added `entity_direct` (teal "직접 언급") + `similarity_fallback`
  // (amber "유사 참고"). Backend uses `entity_direct` when the query
  // resolves to a known entity and only strictly-referencing facts
  // are returned; `similarity_fallback` when the strict path yielded
  // 0 and the similarity kNN filled in. Legacy `embedding` /
  // `entity_link` remain for the non-entity-resolvable path and are
  // rendered by the FE as amber "유사 참고" too (anything non-
  // `entity_direct` reads as "유사 참고").
  match_kind?:
    | 'embedding'
    | 'entity_link'
    | 'entity_direct'
    | 'similarity_fallback';
  // B-40 defect 1: server-resolved entity labels for subject/object.
  // Null when the uid isn't in lucid_objects or when object_value is a literal.
  subject_label?: string | null;
  object_label?: string | null;
  // ★ REQ-011-v2 (★ PO 2026-07-01) — entity-shape object 의 uid.
  //   backend recall route 가 entity 객체일 때 채워서 보낸다 (literal 일 때 null).
  //   미니 그래프가 entity-entity 연결만 모으는 필터 키. stellarRealAdapter
  //   는 predicate 기반 lookup 을 쓰므로 이 필드를 안 읽지만, 이미 backend
  //   row 에 존재해 type 만 노출되지 않은 상태였다.
  object_uid?: string | null;
  // fix/m32b-entity-type-degree-actual-wiring (PO 2026-06-28): server-
  // resolved entity_type for the subject / entity-shape object. The
  // backend resolves lucid_objects.class on the same mget pass that
  // produces the labels above and surfaces it here. Drives node color
  // in StellarGraph via colorForEntityType() — without these fields
  // the renderer falls back to STELLAR_ACCENT for every node and PO's
  // "entity별 구분이 제일 먼저 필요" gate fails.
  // Valid values match ENTITY_COLORS keys in stellarColors.ts:
  //   person / organization / group / product / resource / concept /
  //   knowledge / event / place. Unknown / null -> STELLAR_ACCENT.
  subject_entity_type?: string | null;
  object_entity_type?: string | null;
  // B-62 natural-spo-display: server-resolved natural-English predicate
  // gloss. Null on legacy facts captured before the OPL layer landed;
  // the predicateLabel() helper falls back to the curated KO map / the
  // canonical predicate surface in that case.
  predicate_label?: string | null;
  // v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split. Null
  // on legacy facts; the FactCard treats absence as 'action'.
  // v0.2.0 step 2 (fact-measurement-layer-v1): 3rd bucket adds metric /
  // value / unit / as_of for numeric facts pinned to a timepoint.
  fact_type?: 'action' | 'claim' | 'measurement' | null;
  speaker_uid?: string | null;
  speaker_label?: string | null;
  // ★ REQ-014-D (PO 2026-07-02) — CLAIM 화자 노드 색·타입 회복.
  //   backend recall 이 subject_entity_type 와 같은 mget 배치에서
  //   speaker_uid 도 조회해 채워보낸다. FE stellarRealAdapter 가
  //   ensureEntity(speaker_uid, speaker_label, speaker_entity_type) 로
  //   화자 노드의 entity_type 을 세팅 → StellarEntityCard 팝업의 "타입 변경"
  //   드롭다운이 "기타" 가 아닌 실제 값 (예: person) 을 initial 로 표시.
  //   결과: PO 가 이미 person 인 화자를 person 으로 다시 저장하려 하는
  //   no-op "저장 안 됨" 착각이 사라진다.
  speaker_entity_type?: string | null;
  speech_act?: string | null;
  content_claim?: string | null;
  stance?: string | null;
  metric?: string | null;
  measurement_value?: number | null;
  measurement_unit?: string | null;
  as_of?: string | null;
  // v0.2.0 step 3 (fact-contradiction-detection-v1): count of CONTRADICTS
  // edges where this fact participates. The RecallFactCard renders an
  // amber [⚠ 모순 N건] badge when > 0. Defaults to 0 on legacy responses
  // / older clients — undefined coerces to 0 in the badge guard.
  contradiction_count?: number;
  // feat/stellar-entity-edge-remodel-v2 (PO 2026-06-29):
  // ★ M3-2a backend stores these on lucid_facts but the recall route does
  //   NOT yet surface them on RecallFact. We expose the fields as optional
  //   so the FE stellarRealAdapter can read them defensively (entity-edge
  //   remodel falls back gracefully when undefined). Backend boost to
  //   /api/spaces/{ks}/facts and /api/spaces/{ks}/recall is a separate PR
  //   (see DISCOVERY note in stellarRealAdapter.ts).
  // NB: speaker_uid is already declared above (v0.2 claim-layer field) —
  // not re-declared here.
  /** CLAIM related entities (uids referenced inside content_claim). Drives the
   *  claim→related entity edges in the entity-edge remodel. */
  related_entity_uids?: string[] | null;
  /** Stage 2 — additional ACTION participants beyond subject/object
   *  (recipient / instrument / location / …). Mirrored onto link.roles. */
  fact_object_role?: Record<string, string> | null;
  /** M3-2a stage 4 — verification gate (verified/claimed). Data-only;
   *  the renderer MUST NOT bind to it (PO 정정 spec). The adapter carries
   *  it onto the link as a meta attribute for downstream callers. */
  link_status?: 'verified' | 'claimed' | string | null;
}

export interface EntityFactRef {
  fact_uid: string;
  claim: string;
  predicate: string;
  other_uid: string;
  other_label?: string | null;
}

export interface EntityBriefGroup {
  predicate: string;
  facts: EntityFactRef[];
}

export interface EntityBrief {
  entity_uid: string;
  entity_name: string;
  entity_class?: string | null;
  total_facts: number;
  as_subject: EntityBriefGroup[];
  as_object: EntityBriefGroup[];
}

export interface EntityFacetItem {
  uid: string;
  name: string;
  count: number;
}

// fix/recall-facet-bucket-expand (★ M-Dogfood ⑤⑪ — PO 2026-06-30):
// v3 closed set 10 class 1:1 bucket. 옛 4 bucket 시절 "기타 비대" 해소.
// `other` 는 unknown / heuristic fallback 만 받는다. 모든 필드 optional
// 로 두어 옛 backend (4 bucket) 응답도 깨지지 않게 호환.
export interface EntityFacets {
  // WHO
  person?: EntityFacetItem[];
  organization?: EntityFacetItem[];
  group?: EntityFacetItem[];
  // WHAT
  knowledge?: EntityFacetItem[];
  resource?: EntityFacetItem[];
  task?: EntityFacetItem[];
  concept?: EntityFacetItem[];
  event?: EntityFacetItem[];
  metric?: EntityFacetItem[];
  // WHERE
  location?: EntityFacetItem[];
  // ★ legacy alias — pre-fix backend 가 보낸 4 bucket 응답 호환.
  // 새 backend 는 절대 emit 하지 않음 (place → location 으로 alias).
  place?: EntityFacetItem[];
  other?: EntityFacetItem[];
}

export interface PredicateFacetItem {
  name: string;
  count: number;
}

export interface FactTypeFacets {
  action: number;
  claim: number;
  // v0.2.0 step 2 (fact-measurement-layer-v1) — numeric facts tied to
  // a timepoint. Optional so the response shape can land on a frontend
  // build that pre-dates the measurement layer without crashing.
  measurement?: number;
}

export interface RecallFacets {
  entities: EntityFacets;
  predicates: PredicateFacetItem[];
  // v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split counts.
  fact_types?: FactTypeFacets;
}

export interface RecallResponse {
  signature: string;
  facts: RecallFact[];
  total: number;
  expanded_count?: number;
  entity_brief?: EntityBrief | null;
  // B-49: aggregations for the right-rail facet panel.
  facets?: RecallFacets;
}

// B-62 — facts listing envelope (GET /api/spaces/{id}/facts).
// Mirrors backend/api/models/recall.py::FactsList.
export interface FactsList {
  facts: RecallFact[];
  total: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// feat/ledger-view — LEDGER (제3의 뷰).
// Mirrors backend/api/models/recall.py::LedgerItem / LedgerResponse.
// Deliberately trims score / match_kind / contradiction_count /
// validator_id / validation_method / negation_* / stance — the ledger
// surface doesn't render relevance metadata.
// ---------------------------------------------------------------------------

export interface LedgerItem {
  fact_uid: string;
  claim: string;
  claim_en: string | null;
  subject_uid: string;
  subject_label?: string | null;
  predicate: string;
  predicate_label?: string | null;
  object_value: string;
  object_label?: string | null;
  source_uids: string[];
  validated_at: string;
  knowledge_space_id: string;
  fact_type?: 'action' | 'claim' | 'measurement' | null;
  speaker_label?: string | null;
  speech_act?: string | null;
  content_claim?: string | null;
  metric?: string | null;
  measurement_value?: number | null;
  measurement_unit?: string | null;
  as_of?: string | null;
}

export interface LedgerResponse {
  facts: LedgerItem[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// B-48b — fact detail panel
// ---------------------------------------------------------------------------

export interface FactDetailHeader {
  fact_uid: string;
  claim: string;
  claim_en?: string | null;
  subject_uid: string;
  subject_label?: string | null;
  predicate: string;
  // fix/recall-predicate-and-entity-type (PO 2026-06-26): mirror
  // RecallFact.predicate_label so the detail modal renders the same
  // server-resolved predicate gloss the recall card does. Null on
  // legacy docs; predicateLabel() falls back to the canonical surface.
  predicate_label?: string | null;
  object_value: string;
  object_label?: string | null;
  validated_at: string;
  retracted_at?: string | null;
  retracted_by?: string | null;
  edit_history?: unknown[];
  // fact-display-unification — mirror RecallFact's fact_type layer
  // fields so the Recall detail modal can render the same badge +
  // strip that the list card does. Legacy docs leave these undefined
  // and the shared FactTypeBadge / FactTypeStrip early-return null.
  fact_type?: 'action' | 'claim' | 'measurement' | null;
  speaker_label?: string | null;
  speech_act?: string | null;
  content_claim?: string | null;
  metric?: string | null;
  measurement_value?: number | null;
  measurement_unit?: string | null;
  as_of?: string | null;
}

export interface FactDetailEntity {
  uid: string;
  name: string;
  name_en?: string | null;
  class?: string | null;
  role: 'subject' | 'object';
  aliases?: string[];
}

export interface FactDetailSource {
  source_uid: string;
  source_job_id?: string | null;
  url: string;
  domain?: string | null;
  captured_at?: string | null;
  source_type?: string | null;
  author?: string | null;
  title?: string | null;
  snapshot_available?: boolean;
}

export interface FactDetailResponse {
  fact: FactDetailHeader;
  entities: FactDetailEntity[];
  sources: FactDetailSource[];
}

export interface FactMutationResponse {
  fact_uid: string;
  retracted_at: string | null;
  source_uids: string[];
  auto_retracted: boolean;
}

// feat/fact-detail-modify — PATCH body for the Recall detail modal's
// inline edit affordance. Only surface fields are accepted; identity
// (subject_uid / predicate_code / validation_method) is immutable here
// — structural changes go through retract + re-validate.
export interface ModifyFactRequest {
  claim?: string;
  predicate_label?: string;
  object_value?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// B-55 / B-57 — Home brief response shape (mirrors backend; the runtime fetch
// is fail-soft so this type lands even before B-55 is merged).
// ---------------------------------------------------------------------------

export interface HomeBriefTotals {
  facts: number;
  entities: number;
  sources: number;
  this_week_validated: number;
}

export interface HomeBriefValidatedFact {
  fact_uid: string;
  claim: string;
  subject_label?: string | null;
  validated_at: string;
}

export interface HomeBriefCluster {
  entity_uid: string | null;
  entity_name: string | null;
  linked_count: number;
}

export interface HomeBrief {
  totals: HomeBriefTotals;
  pending_validation: number;
  recent_validated: HomeBriefValidatedFact[];
  top_cluster: HomeBriefCluster | null;
  is_empty: boolean;
}

// ---------------------------------------------------------------------------
// M4a — assistant brief (verified KG retrieval + grounded LLM inference)
// ---------------------------------------------------------------------------

export interface VerifiedFactEntry {
  fact_uid: string;
  subject: string;
  predicate_label: string;
  object: string;
  sources: string[];
}

export interface AssistantBriefResponse {
  verified: VerifiedFactEntry[];
  inference: string;
  grounded: boolean;
}

// spo-pending-ux — entity suggestion + predicate autocomplete
export interface EntitySuggestion {
  entity_id: string;
  primary_label: string;
  primary_lang: 'ko' | 'en' | '';
  score: number;
}

export interface PredicateEntry {
  code: string;
  label_ko: string;
  label_en: string;
}
