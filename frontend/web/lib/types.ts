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
