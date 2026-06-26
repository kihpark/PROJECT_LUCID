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
  match_kind?: 'embedding' | 'entity_link';
  // B-40 defect 1: server-resolved entity labels for subject/object.
  // Null when the uid isn't in lucid_objects or when object_value is a literal.
  subject_label?: string | null;
  object_label?: string | null;
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

export interface EntityFacets {
  organization: EntityFacetItem[];
  person: EntityFacetItem[];
  place: EntityFacetItem[];
  other: EntityFacetItem[];
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
