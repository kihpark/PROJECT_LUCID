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

export interface RecallFacets {
  entities: EntityFacets;
  predicates: PredicateFacetItem[];
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
// B-48b — fact detail panel
// ---------------------------------------------------------------------------

export interface FactDetailHeader {
  fact_uid: string;
  claim: string;
  claim_en?: string | null;
  subject_uid: string;
  subject_label?: string | null;
  predicate: string;
  object_value: string;
  object_label?: string | null;
  validated_at: string;
  retracted_at?: string | null;
  retracted_by?: string | null;
  edit_history?: unknown[];
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
