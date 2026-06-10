# chore/lucid-decided-facts-filter — get_pending_detail filters decided + exposes set

Off `main`. **Walking-Skeleton Iteration 4 Bug 1.** Small UX fix; data integrity was always fine.

## Diagnosis

PO clicked "Accept all 1 facts" → toast: "Decisions recorded — 1 accepted ✓". Reload → still shows "Accept all 1 facts" → click again → "Decisions recorded — 0 accepted". PO worried about data loss.

Trace:
- First `POST /pending/{job_id}/accept-all` → `create_fact` indexes the fact into `lucid_facts` ES (✓) + appends `fact_uid` to `extracted_metadata['structure'].decided_fact_uids`
- Next `GET /pending/{job_id}` returns **all** facts unfiltered. UI shows "1 facts pending".
- Repeat POST → backend's `accept-all` is idempotent (`already_decided` filter at line 429) → returns empty `accepted_facts` array → toast says "0 accepted"

**Conclusion:** the fact persisted on the first click; the second click just hit the idempotent NO-OP. The misleading UX is the API returning facts it already knows are decided.

## Fix at the API boundary

### 1. `PendingJobDetail` gains `decided_fact_uids: list[str]`

```python
class PendingJobDetail(LucidBaseModel):
    ...
    facts: list[dict[str, Any]] = Field(default_factory=list)
    decided_fact_uids: list[str] = Field(default_factory=list)
    ...
```

Lets the UI render counts ("3 of 5 facts decided") without re-fetching.

### 2. `get_pending_detail` filters `facts` to PENDING-only

```python
decided = set(s.get("decided_fact_uids") or [])
all_facts = s.get("facts_summary", []) or s.get("facts", []) or []
pending_facts = [
    f for f in all_facts
    if (f.get("fact_uid") or f.get("uid")) not in decided
]
```

## Behaviour after this PR

| Call | Returns |
|------|---------|
| GET before any accept | `facts: [all N pending]`, `decided_fact_uids: []` |
| POST /accept-all (first) | `accepted_facts: [N uids]` |
| GET after | `facts: []`, `decided_fact_uids: [N uids]` |
| UI | "0 pending fact(s)" honestly, can render "All N facts decided" |

Repeated POST stays idempotent; the misleading "Accept all 1 facts" button no longer appears for a fully-decided job.

## Tests — 2 new (total 15 in `test_validate_routes_unit.py`)

| Case | Asserts |
|------|---------|
| `test_pending_job_detail_carries_decided_fact_uids_field` | field exists + survives `model_dump(mode='json')` for the FastAPI response surface |
| `test_pending_job_detail_default_decided_fact_uids_is_empty` | back-compat — clients that don't send the field get an empty list, not a ValidationError |

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in 90 source files |
| `pytest tests/unit -q` | **220 passed** (was 218; **+2 chore 7**) |

## Commit

```
e5ab8b0  chore(validate): filter decided facts in get_pending_detail + expose set
```

## What this PR does NOT do

- Does NOT change the **frontend** — the response shape is a superset (new field optional), so existing UI still works. A follow-up can render the decided count, but the immediate confusion is resolved by the filtered `facts` array.
- Does NOT filter the Pending Queue list (`GET /pending`) — a fully-decided job is still listed there. Filtering the queue is a separate UX call.
- Does NOT touch Korean media compatibility (chore 6 — sequenced after this).

## Test plan (PO machine)

- [ ] `cd backend && pytest tests/unit -q` → 220 pass
- [ ] After merge + `docker compose restart backend`: visit `/pending/<UUID>` for the previously-accepted job
- [ ] Page now shows "0 pending fact(s)" (matching the actual state) instead of "Accept all 1 facts"
- [ ] Capture a fresh article → still works end-to-end through the Decide Overlay
- [ ] `SELECT extracted_metadata->'structure'->'decided_fact_uids' FROM source_jobs WHERE id=...` confirms the array is populated
