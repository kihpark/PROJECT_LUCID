# chore/lucid-fact-content-persistence — persist decomposer facts/objects/links

Off `main`. **Walking-Skeleton Iteration 3 Bug 1.** Critical-path fix — without this, the Decide Overlay shows "0 pending fact(s)" on every capture and the beta wedge can't be validated.

## Diagnosis (PO DB query)

```
SELECT id, status, extracted_metadata->'structure'->'fact_count'
FROM source_jobs;
  -> 1 row with fact_count=1, but no fact CONTENT anywhere in the row
```

PR-3-3's `process_extracted_job` stamps `fact_count` + `match_summaries` + `disambiguation_pending` but **never** serialises `decomp.facts` / `decomp.objects` / `decomp.fact_object_links` / `decomp.fact_fact_links`. The Validate API (`GET /api/spaces/{sid}/pending/{job_id}`) reads:

```python
facts=s.get("facts_summary", []) or s.get("facts", []),
objects=s.get("objects_summary", []) or s.get("objects", []),
fact_object_links=s.get("fact_object_links_detail", []),
fact_fact_links=s.get("fact_fact_links_detail", []),
```

…all of which got back empty arrays.

## Storage location decision

| Option | Verdict |
|--------|---------|
| **A. `extracted_metadata.structure.facts[]` (JSONB)** | ✅ chosen — per DR-067 |
| B. New `facts` JSONB column on `source_jobs` | rejected — equivalent capability, requires Alembic migration |
| C. New `facts` table | rejected — directly contradicts DR-067 |

DR-067 is explicit: "Pending Validate data is staged in `SourceJob.extracted_metadata['structure']` JSONB, NOT in a separate `pending_facts` table". The bug isn't the storage choice; it's the omission of the content payload.

## Three changes

### 1. `processor._serialize_struct_fact(f)`

```python
def _serialize_struct_fact(f: StructureFact) -> dict[str, Any]:
    d = f.model_dump(by_alias=True, mode="json")
    if "uid" in d and "fact_uid" not in d:
        d["fact_uid"] = d["uid"]
    return d
```

`by_alias=True` rewrites `type_` → `type`; the `uid` → `fact_uid` projection keeps the route's `facts.fact_uid || facts.uid` fallback working without a special-case branch.

### 2. `processor._serialize_struct_object(o)`

Same alias pattern: `class_` → `class`; properties coerced to a plain dict so test-side re-validation under `extra='forbid'` doesn't trip on Mapping subclasses.

### 3. `processor.process_extracted_job` — four new keys on `meta['structure']`

```python
meta["structure"] = {
    # ... existing counts ...
    "matches": match_summaries,
    "disambiguation_pending": disambig_pending,

    # chore 5 — full content payloads the Decide Overlay reads:
    "facts": facts_payload,                            # list[FactSummary]
    "objects": objects_payload,                        # list[ObjectSummary]
    "fact_object_links_detail": fact_object_links_detail,
    "fact_fact_links_detail": fact_fact_links_detail,
}
```

`object_uid` on each fact_object_link is remapped via `uid_map` to the matched_object_uid (the real persisted UID), not the LLM-emitted placeholder.

**Back-compat invariant**: the pre-chore-5 integer keys (`fact_object_links` / `fact_fact_links` / `negates_links` / `links_skipped`) are kept as integers. Readers that treat them as counts still work; readers that want the records use the new `*_detail` arrays.

## Tests — 3 new (total 11 in `test_structure_processor.py`)

| Case | Asserts |
|------|---------|
| `test_processor_persists_facts_content` | every fact's claim / type / subject_uid / predicate / object_value lands; both `fact_uid` and `uid` keys present |
| `test_processor_persists_objects_with_class_alias` | objects[] uses `class` (alias) NOT `class_`; name / uid / properties all present |
| `test_processor_persists_links_detail` | `fact_object_links_detail` carries the remapped object_uid + link_type='involves'; `fact_fact_links_detail` empty by default |

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in 90 source files |
| `pytest tests/unit -q` | **218 passed** (was 215; **+3 chore 5**) |

## Commit

```
9e5b990  chore(structure): persist facts/objects/links content into structure metadata
```

## What this PR does NOT do

- Does NOT backfill the 1 existing `structured` job — the row has no fact content because it was processed before this fix; PO can re-capture or hand-update the JSONB
- Does NOT fix the `fact_uid` collision risk across captures (the LLM emits `fn-1` each time) — separate concern, not on the Iteration 3 critical path
- Does NOT touch the silent `structure_failed` diagnostic — that's chore 6, PO sequenced after this lands
- Does NOT change the route schema or the web client types — both already expect these keys

## Test plan (PO machine)

- [ ] `cd backend && pytest tests/unit/test_structure_processor.py -q` → 11 pass
- [ ] After merge: `docker compose restart backend`, capture a new web article via Chrome Extension
- [ ] Watch `[ssr-fetch]` log line in `pnpm dev` confirm backend reached on `backend:8000`
- [ ] `SELECT extracted_metadata->'structure'->'facts' FROM source_jobs ORDER BY created_at DESC LIMIT 1;` → non-empty JSON array
- [ ] Visit `/pending/<UUID>` → Decide Overlay shows the actual fact count, the FactCard renders the claim text, and Accept all works end-to-end
- [ ] First real beta wedge validation possible
