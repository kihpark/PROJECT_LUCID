# CONTRADICTION_DISCOVERY — v0.2.0 step 3 of 3

## 0.1 fact_relations schema (current)

File: `backend/api/storage/postgres/orm.py::FactRelation`

Columns:
- `relation_id` UUID PK (gen_random_uuid default)
- `from_fact_uid` String(64) NOT NULL, indexed
- `to_fact_uid` String(64) NOT NULL, indexed
- `relation_type` String(32) NOT NULL — vocabulary validated at API layer,
  NOT a CHECK constraint (B-54 deliberately so the vocab can extend
  without alembic churn). Class docstring lists SUPPORTS / CONTRADICTS /
  CAUSES / ELABORATES (UPPERCASE convention).
- `corroboration_source_count` Integer NOT NULL DEFAULT 0
- `corroboration_source_diversity` Integer NOT NULL DEFAULT 0
- `created_at` TIMESTAMPTZ NOT NULL
- `validated_at` TIMESTAMPTZ NULL

**Diffs vs the proposed prompt:**
- **No `knowledge_space_id` column.** The B-54 scaffold relies on
  fact_uids being globally unique (lucid_facts ID is the new_uid() UUID).
  Cross-KS isolation therefore comes from the FACT lookup, not from a
  ks_id filter on fact_relations. Decision: do **not** add a KS column
  here (that would mutate alembic and is forbidden by the spec). When
  surfacing in Recall we filter relations by `from_fact_uid IN (page
  uids of this KS)`; since fact_uids are globally unique, this still
  enforces KS isolation cleanly.
- **No `evidence` JSONB column.** Detector will compute evidence at
  detection time but NOT persist it (the row only carries the typed edge
  pointer). When the resolution UI lands we can either add the column
  or derive evidence fresh on display.
- **No (relation_type) index** beyond per-uid indexes. At dogfood scale
  acceptable; we filter by `relation_type='CONTRADICTS' AND
  from_fact_uid IN (...)` and the from_fact_uid index drives the scan.
- **Uppercase convention.** Use `relation_type='CONTRADICTS'` (matches
  the docstring's enumerated set). The prompt's `'contradicts'` is
  lowercased; standardise on UPPERCASE to be consistent with the
  scaffold's intent.

## 0.2 Where to trigger detection

Options:
- (a) Sync in `validate.decide` after bulk_create_facts succeeds and the
  job is flipped to `validated`.
- (b) Background task — out of scope (no Celery / arq in beta).
- (c) Batch cron — wasted latency, no UI signal.
- (d) Admin endpoint only — too invisible for dogfood.

**Choice: (a).** Same for `accept_all` — both writes land facts into ES
in a single Submit click; the user expects the next /recall to show
contradiction badges. Cost is bounded because at dogfood scale a KS
holds tens of facts (low hundreds); the two ES scans are
`size=10_000` ceiling but in practice <500 hits per call.

**Safety:** wrapped in `try/except` with `logger.warning` — detection
failure must NEVER fail the Submit. The job is already validated; the
user-facing transaction must succeed.

## 0.3 Natural key per layer (KEEP VERBATIM)

- **measurement**: `(metric, subject_uid OR speaker_uid, as_of)` — same
  triple + different `measurement_value` (numeric Δ > 1e-9) = candidate.
- **action**: `(subject_uid, predicate_code, object_canonical OR object_value)`
  + `negation_flag` polarity flip = candidate.
- **claim**: DEFER (text similarity heavyweight).
- **cross-layer**: DEFER.

We keep keys verbatim — no Levenshtein, no lowercasing aggregation. PO
can broaden later if false negatives surface.

## 0.4 OPL predicate_code

Confirmed: `predicate_code` lives on the lucid_facts ES doc (see
`backend/api/storage/elasticsearch/facts.py::insert_or_dedup_fact`
body construction — `body["predicate_code"] = predicate_code`). When
absent (legacy pre-OPL facts), the action layer skips them (key
returns None).

## 0.5 Where the detector module belongs

`backend/api/structure/completeness_validator.py` already exists in
the `structure/` package and is the closest sibling (a deterministic
post-Structure analyzer that does NOT call an LLM). Place the new
module at:

`backend/api/structure/contradiction_detector.py`

The directory has `__init__.py`. No import path changes required.

## 0.6 Recall projection point

`backend/api/routes/recall.py::_hit_to_fact` constructs each
`RecallFact`. We bulk-look-up contradictions for ALL page uids in ONE
Postgres query, then pass a map `fact_uid -> count` into a wrapper.
No N+1.
