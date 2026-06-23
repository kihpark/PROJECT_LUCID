# feat/negation-policy-consistency — Discovery

## 0.1 Where the warning is currently rendered in Pending

Single location — the pending queue list card summary in
`frontend/web/components/PendingQueueList.tsx:148-155`:

```tsx
{job.has_negation && (
  <span
    className="text-accent-error text-xxs font-mono self-end"
    title="negation_flag"
  >
    ⚠ negation
  </span>
)}
```

`job.has_negation` is a boolean computed by the backend
(`backend/api/routes/validate.py::_job_summary`, line 197-201):

```python
negation = any(
    bool(m.get("negation_flag"))
    for m in facts_summary
    if (m.get("fact_uid") or m.get("uid")) not in decided
)
```

So the predicate is purely "any pending fact in this job has
`negation_flag` set" — i.e. the LLM saw `안 / 없 / 못` somewhere.
No contradiction relation is consulted.

The `/pending/{jobId}` detail route renders facts via
`DecideOverlay -> FactCard`, which **already** has the badge
removed (`FactCard.tsx:456-459`, per `decide-ux-v3`). So there is
no per-fact-block negation rendering in the pending detail path —
only the queue summary card.

## 0.2 What Decide does (the correct path — for reference)

`frontend/web/components/FactCard.tsx:456-459`:

```tsx
{/* decide-ux-v3: negation badge UI removed per PO ("필요 없다"). */}
{/* The underlying fact.negation_flag + negation_scope data is */}
{/* preserved on the FactNode in storage — kept as substrate for */}
{/* future contradiction detection. UI surface only is removed. */}
```

Tests `FactCard.test.tsx:812-870` assert no badge renders even
when `negation_flag=true` and `scope='full' | 'partial'`. Confirmed
no regression risk from re-introducing it.

## 0.3 How to know there's a contradiction

`FactRelation` ORM in `backend/api/storage/postgres/orm.py:643-680`:

- `__tablename__ = "fact_relations"`
- Columns: `relation_id`, `from_fact_uid`, `to_fact_uid`,
  `relation_type` (one of SUPPORTS / CONTRADICTS / CAUSES /
  ELABORATES), `corroboration_source_count`,
  `corroboration_source_diversity`, `created_at`, `validated_at`.
- NOTE column names differ from the brief: `from_fact_uid` /
  `to_fact_uid` (not `subject_fact_uid` / `object_fact_uid`).
- Per the class docstring: **"Schema-only in this PR; no call-site
  populates the table yet."**

Verified with grep — no `FactRelation(...)` constructor call exists
in `backend/api/` outside of the schema test
`tests/integration/test_data_bedrock_schema.py:98`. Production code
never writes a row.

For a pending-stage fact, the situation is worse: pending facts
live in `SourceJob.extracted_metadata['structure']['facts_summary']`
as JSONB; they only get a real `fact_uid` row in `lucid_facts`
**after** the user accepts them in Decide. So a contradiction
query against `fact_relations` would always return 0 for any
fact in the pending queue.

## 0.4 Is the contradiction info already in /pending API?

No — `PendingJobSummary` exposes `has_negation`, `has_disambiguation`
and counts, but nothing about contradiction relations. Adding it
would require:

  (a) populating `fact_relations` at some pipeline stage (out of
      scope for this PR — no PR has ever wired it up),
  (b) computing the count against pending JSONB facts that don't
      yet have committed `fact_uid` keys (impossible without a
      semantic comparison pass — out of scope per the brief's
      "DO NOT introduce a new negation classifier or LLM call").

## Decision

Per the brief's explicit fallback (Step 1.2):

> Decision: if contradiction info is impractical at pending stage,
> **DEFAULT to NOT showing the warning at all** in pending. The
> badge can fire only after a fact has been validated and a
> contradiction relation is recorded.

This aligns Pending with Decide (`feat/decide-ux-v3`) on the same
policy: **no negation badge purely on `negation_flag`.** The badge
can be re-introduced — keyed on a real `contradiction_count` field
— when `fact_relations` is actually populated (a future PR after
B-54 wires up the writer).

Data substrate preserved:
- `negation_flag` / `negation_scope` stay on `FactNode` (per the
  brief's "DO NOT delete the `negation_flag` field" constraint).
- `has_negation` stays on `PendingJobSummary` so the
  `PendingFilters` "Has negation" debug toggle keeps working
  (developer-facing analytics; not the user-facing warning).
- `has_negation_flag` query parameter on `GET /pending` stays.

Only the user-facing `⚠ negation` chip in
`PendingQueueList.tsx:148-155` is removed.

## Scope summary

- Frontend: PendingQueueList.tsx — remove the badge render block;
  add a documentation comment pointing to this discovery + the
  decide-ux-v3 antecedent.
- Frontend tests: update PendingQueueList.test.tsx — flip the
  expectation from "negation indicator renders when has_negation"
  to "negation indicator never renders". Disambig assertion stays
  (disambig is real state, not negation policy).
- Backend: untouched. `has_negation` field stays on the API. The
  filter still works (debug tool). Grade: CODE-only frontend.
