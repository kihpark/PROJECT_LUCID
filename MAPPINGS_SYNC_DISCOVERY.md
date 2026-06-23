# MAPPINGS_SYNC_DISCOVERY

## 0.1 mappings.py current state

File: `backend/api/storage/elasticsearch/mappings.py`

All three indexes use `"dynamic": "strict"` (rejects any field not declared).

### LUCID_FACTS_MAPPING (currently declared `properties`, 33 fields)
fact_uid, claim, claim_en, type, subject_uid, predicate, predicate_label,
object_value, valid_from, validated_at, validation_method, validator_id,
source_uids, predicate_code, original_surface, capture_lang, object_canonical,
canonical_key, needs_review, tags, aliases, override_warning, negation_flag,
negation_scope, edit_history (nested), retracted_at, retracted_by,
locators (nested), knowledge_space_id, embedding (dense_vector),
created_at, updated_at.

Notes on existing declarations vs runtime patch:
- `predicate_label` declared as `text/standard` (not `keyword` as patched).
  Per task constraint "DO NOT modify existing field types" — keep as text.
- `object_canonical` declared as `keyword` (not `object,enabled=False` as
  patched). Per same constraint — keep as keyword. The natural-spo writer
  emits a flat string here, so keyword is correct.
- `predicate_code`, `original_surface`, `capture_lang`, `tags`,
  `canonical_key`, `needs_review` — ALL ALREADY DECLARED. The runtime
  put_mapping for these was a no-op against the file source; they were
  missing only because the dev cluster's mapping had drifted from the
  current file (likely the cluster was created off an earlier checkout).

### LUCID_FACTS_MAPPING — MISSING fields the writer code emits
- `subject_label` — set by `processor._serialize_struct_fact` (line 593)
- `object_label`  — set by `processor._serialize_struct_fact` (line 610)
- `predicate_violation` — set by `processor._serialize_struct_fact` (line 526)

### LUCID_OBJECTS_MAPPING (currently declared `properties`, 14 fields)
object_uid, class, name, name_en, primary_label (text+keyword),
primary_lang, entity_type, aliases (text+keyword), properties (object,
dynamic), fact_uids, connected_objects (nested), embedding, knowledge_space_id,
created_at, updated_at, relabel_history (nested).

### LUCID_OBJECTS_MAPPING — MISSING fields the writer code emits
None. `primary_label` and `primary_lang` are already declared in the
file (the runtime put_mapping was reconciling a drifted live cluster).

### LUCID_SOURCES_MAPPING / LUCID_APPLICATIONS_MAPPING
Unchanged — no writer drift detected.

### Comment/changelog tracking
The file uses inline `# B-62 ...` change tags per field. No top-level
changelog section. New additions will use the same convention.

## 0.2 Data-shape sources

- `lucid_objects.primary_label` / `primary_lang` — written by entity
  resolver pipeline. Already declared in mappings.py.
- `lucid_facts.subject_label` / `object_label` / `predicate_violation`
  — written by `backend/api/structure/processor.py::_serialize_struct_fact`
  (the spo-decide-payload-wire path). NOT YET DECLARED — primary gap
  this PR closes.
- All other runtime-patched fields are already declared in mappings.py.

## 0.3 Index recreation paths

- `backend/api/storage/elasticsearch/indexes.py`
  - `create_indexes()` — idempotent: `exists` if present, else creates
    fresh from INDEX_MAPPINGS.
  - `delete_indexes()` — for teardown.
  - `reindex_all()` — destructive drop+recreate (one-off migration).
  - `ensure_negation_fields()` — additive put_mapping for negation_flag /
    negation_scope on lucid_facts. EXISTING template for the
    non-destructive sync this PR generalizes.
  - `_applications_mapping_needs_recreate()` — DESTRUCTIVE detector,
    fires only on LUCID_APPLICATIONS (legacy v8.2 form migration).
    Per task: do NOT extend this to lucid_facts / lucid_objects.

## 0.4 Existing tests

- `backend/tests/unit/test_es_mappings.py` — asserts:
  - 4 indexes present in INDEX_MAPPINGS (facts/objects/sources/applications)
  - facts uses korean_analyzer on claim/aliases, standard on claim_en
  - facts has no valid_until / is_stale / stale_at
  - embedding dims = 1536, cosine, hnsw
  - objects.connected_objects is nested
  - sources has source_uid/domain/source_type/url/first_captured_at/
    capture_count/knowledge_space_id

No field-presence assertions for the B-62 entity-layer fields yet.

## Summary of code changes this PR makes

1. mappings.py — add 3 missing fields to LUCID_FACTS_MAPPING:
   `subject_label`, `object_label`, `predicate_violation`.
   LUCID_OBJECTS_MAPPING — no source change needed (file already
   correct), but include a defensive doc comment noting that
   ensure_mappings() handles any drift on live clusters.
2. indexes.py — add `ensure_mappings(client)` — non-destructive
   field-level put_mapping sweep across facts/objects/sources.
3. main.py — wire `ensure_mappings()` into the lifespan after
   `create_indexes()`.
4. test_es_mappings.py — add presence assertions for the new + B-62
   fields on both LUCID_FACTS_MAPPING and LUCID_OBJECTS_MAPPING.
5. test_ensure_mappings.py — NEW integration test (4 cases).
6. test_indexing_with_full_fields.py — NEW integration test (3 cases).
