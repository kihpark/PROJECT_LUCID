# M4a Discovery — Verified Briefing Assistant

## recall retrieval helpers

- `_resolve_space(session, space_id, user)` (line 83): takes SQLAlchemy session + uuid.UUID + User. Raises 404/403.
- `_hit_to_fact(hit)` (line 267): raw ES hit dict -> RecallFact or None. Drops non-manual rows.
- `_knn_facts_validated_only(embedding, knowledge_space_id, k, ...)` (line 218): ES kNN with validation_method=manual filter.
- `_new_session()` (line 79): creates SQLAlchemy session.

## RecallFact fields

fact_uid, claim, claim_en, subject_uid, predicate, object_value, source_uids, validated_at, validator_id, validation_method, knowledge_space_id, negation_flag, negation_scope, score, match_kind, subject_label, object_label, predicate_label

## Claude client

- `decompose_via_claude` exists but is domain-specific (returns StructureResult).
- ANTHROPIC_API_KEY env var. Default model: claude-sonnet-4-5. M4a uses claude-sonnet-4-6.
- `_parse_json_safely` and `_strip_json_fences` helpers already exist.
- Added: `call_claude_structured(system_prompt, user_prompt, max_tokens, model)`.

## ES query helper name

`knn_search_facts` in queries.py returns _source dicts only. Recall route uses inline `_knn_facts_validated_only` which returns raw hits with _score. Assistant imports from recall directly.

## Auth gate

`from api.security import get_current_user` - standard FastAPI Depends returning User ORM.

## Frontend

- `request<T>()` private in api.ts. No exported fetchWithAuth. Follow same pattern.
- `useAuthMe()` returns { me, loading, error }. MeResponse has default_space_id.
- AppShell nav array at line 368: add { href: '/assistant', label: '어시스턴트' } before 검증.
