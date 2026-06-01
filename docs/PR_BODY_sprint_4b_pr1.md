# Sprint 4B PR-4B-1 — Validate API: 10 endpoints, ValidationLog + Alembic 0014, decision-anonymized telemetry

Off `main` (commit 6756bde). First PR of Sprint 4B — lights up the HITL Validate path that the Decide Overlay (wireframes C-3 / C-4) and the Pending Queue (Q-1 / Q-2 / Q-3) will fetch from.

After PR-3-3, the CSVS chain delivers structured facts but the user can't yet act on them — they live in `SourceJob.extracted_metadata['structure']` with no UI / API path to graduate them into `lucid_facts`. **PR-4B-1 closes that gap** with the four endpoint groups the spec calls for, the `validation_logs` table, and the recorder that lets DCR-001 measure user-decision accuracy.

PR-4A-1 / PR-4A-2 (Validate UI) build on this API.

## What changed

### `backend/api/routes/validate.py` — 10 endpoints (full rewrite from Sprint 1B stub)

| Group | Method | Path | Purpose |
|-------|--------|------|---------|
| A | GET | `/api/spaces/{sid}/pending` | List structured jobs; filters: `source_url`, `source_type`, `captured_after`, `captured_before`, `has_negation_flag`, `has_disambiguation`. Paging: `offset` (≥0), `limit` (1–100, default 20). Sort: `captured_at desc`. |
| A | GET | `/api/spaces/{sid}/pending/{job_id}` | Single job — full decomposition (facts + objects + fact↔object/fact links + disambig pending) |
| B | POST | `/api/spaces/{sid}/pending/{job_id}/decide` | Per-fact `accept`/`edit`/`discard` + per-Object `create_new`/`merge_with`/`skip` |
| B | POST | `/api/spaces/{sid}/pending/{job_id}/accept-all` | Quick path: accept every PendingFact |
| B | POST | `/api/spaces/{sid}/pending/{job_id}/discard` | Discard the whole job |
| C | GET | `/api/spaces/{sid}/disambig` | Cross-job PendingDisambig queue |
| C | POST | `/api/spaces/{sid}/disambig/{disambig_id}/resolve` | `merge_with` / `create_new` / `skip` |
| D | POST | `/api/spaces/{sid}/facts/{fact_uid}/notes` | Create a Review-mode personal note |
| D | GET | `/api/spaces/{sid}/facts/{fact_uid}/notes` | List notes on a fact |
| D | DELETE | `/api/spaces/{sid}/facts/{fact_uid}/notes/{note_id}` | Delete a note |

**Auth pattern (every endpoint):** owner check via `_resolve_space(space_id, user)` → 404 if not found, 403 if owned by a different user.

**Decide → FactNode promotion flow:**

1. `extracted_metadata['structure'].facts_summary` is the canonical PendingFact staging area — no separate `pending_facts` table.
2. On `action='accept'`, the route builds a `FactNode` (validation_method=`manual`, validator_id=`current_user`) and calls `api.storage.elasticsearch.facts.create_fact(node, with_embedding=False)`.
3. On `action='edit'`, the resulting FactNode carries the original claim string in `aliases[]` — **DR-036 search-robustness invariant**.
4. On `action='discard'`, only `validation_logs` records; nothing lands in ES.
5. Every action appends the `fact_uid` to `extracted_metadata['structure'].decided_fact_uids` so the UI can hide decided cards on the next fetch.

**Disambig flow:** `disambig_id` is the synthetic `{job_id}:{llm_uid}` pair. `merge_with` records `merge_target_uid` in `validation_logs.decision_metadata` (ES capture_count bump is PR-4A scope). The entry is removed from `disambiguation_pending` and `object_disambig_pending` is decremented atomically with the row commit.

### `backend/api/models/validate.py` — 11 Pydantic request/response shapes

`PendingFilters`, `PendingJobSummary`, `PendingJobDetail`, `PendingPage`, `FactDecision`, `ObjectDecision`, `DecideRequest`, `DecideResponse`, `DisambigEntry`, `DisambigResolveRequest`, `GraphNoteCreateRequest`, `GraphNoteResponse`. All `extra="forbid"` and `validate_assignment=True` via `LucidBaseModel`.

### `backend/api/storage/postgres/orm.py` + Alembic `0014_validation_logs`

```python
class ValidationLog(Base):
    __tablename__ = "validation_logs"
    # columns:
    #   id, user_id (FK CASCADE), validator_id (FK CASCADE),
    #   source_job_id (FK SET NULL — preserve aggregate on job delete),
    #   fact_uid, object_uid, action,
    #   edited_claim_len (int), decision_metadata (JSONB),
    #   validated_at
    # CHECK: action IN ('accept', 'edit', 'discard', 'merge_with',
    #                   'create_new', 'skip', 'accept_all', 'discard_job')
    # INDEX: source_job_id, fact_uid
```

**DCR-001 privacy invariants** (enforced by tests):
- NO claim text → only `edited_claim_len` (an int)
- NO source URL, NO object name, NO raw payload
- `decision_metadata` JSONB carries small tags only (`merge_target_uid`, link_type list, candidate count)

### `backend/api/metrics/precision.py` — fifth recorder

`record_validation_decision(session, *, user_id, validator_id, source_job_id, fact_uid, object_uid, action, edited_claim_len, decision_metadata)` — same shape as `record_validate_decision` / `record_negation_correction` / `record_contradiction_confirmation` / `record_structure_metrics`. Same anonymization rules.

### Tests — 13 unit + 5 integration

**Unit** (`tests/unit/test_validate_routes_unit.py`):
- Pydantic guards: `PendingFilters` all-optional; `FactDecision`/`ObjectDecision`/`DisambigResolveRequest` reject unknown actions; `GraphNoteCreateRequest` rejects empty + caps at 8000 chars
- `record_validation_decision`: writes a `ValidationLog` row with the right fields; `session.flush()` called
- `ValidationLog`: enumerated PII column ban (claim/claim_text/edited_claim/source_url/object_name/fact_text/raw_payload all absent); required column set present
- CHECK clause enumerates exactly the 8 supported actions

**Integration** (`tests/integration/test_validate_e2e.py`, skip-pattern):
1. `pending_to_accepted` — seed structured job → GET /pending lists it → POST /accept-all flips 3 facts (ES `create_fact` mocked)
2. `pending_with_edit_preserves_aliases` — edit puts the original claim into the resulting `FactNode.aliases[]` (DR-036 verified)
3. `pending_with_discard_logs` — discard writes a `validation_logs` row with no claim text leak
4. `disambig_resolution_merge` — seed disambig → resolve `merge_with` → queue is empty
5. `graph_note_search` — POST → GET → DELETE → GET-empty round-trip

### `AGENTS.md` — §3 + §4.5

- §3 routes/validate.py entry rewritten with the 10-endpoint surface
- §3 new entries for `models/validate.py` + alembic 0014 + `ValidationLog`
- §4.5 gains a "Validate stage endpoints (Sprint 4B PR-4B-1)" subsection with the endpoint table + Decide-to-FactNode flow + privacy invariants

## DoD verified locally

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in **90** source files |
| `pytest tests/unit -q` | **215 passed** in 3.0s (was 202 in track A; **+13** PR-4B-1 unit) |
| `pytest tests/integration/test_validate_e2e.py --collect-only -q` | **5 tests collected** |

### DoD I could not verify locally
- Live Alembic upgrade (`alembic upgrade head` on a clean Postgres) — PO docker validates
- Live ES `create_fact` round-trip into `lucid_facts` — integration tests mock at the API boundary; PR-4A end-to-end exercises the round-trip
- Object capture_count bump on disambig `merge_with` — deferred to PR-4A integration

## Commits

```
074dac9  docs(sprint-4b-pr1): AGENTS §3 routes/validate + 0014 + §4.5 Validate endpoints
12586a5  test(sprint-4b-pr1): 13 unit + 5 integration tests for Validate endpoints
58974d6  feat(sprint-4b-pr1): Validate routes — 10 endpoints (Pending + Decide + Disambig + Notes)
937ea5e  feat(sprint-4b-pr1): ValidationLog + Alembic 0014 + record_validation_decision
```

## What this PR does NOT do

- Does NOT bump `lucid_objects.capture_count` on disambig `merge_with` — the route logs the intent; PR-4A integration tests reconcile against live ES
- Does NOT render the Decide Overlay UI — that is PR-4A-1
- Does NOT render the Pending Queue list page or Auto-accepted tab — that is PR-4A-2
- Does NOT introduce a separate `pending_facts` table — `extracted_metadata['structure']` JSONB stays the canonical staging area
- Does NOT auto-promote `auto-accepted` (trusted-source) facts — Sprint 5 carries the `trusted` source policy work; this PR's accept-all only fires on explicit user click
- Does NOT modify the `validate_assignment` invariant on any Pydantic shape; every new model inherits from `LucidBaseModel` (Sprint 0)

## Sprint coordination

- **Off** `main` (commit 6756bde, includes Sprint 3 + DCR-002 v2)
- **Alembic chain:** 0001 → 0013 (DR-066 understanding_depth_logs) → **0014** (this PR validation_logs)
- **Stacked-on:** none — track B (Sprint 2A Chrome Extension) and PR-4A-1 both branch off main in parallel without conflict

## Test plan

- [ ] Branch base check: `git log main..HEAD --oneline` shows the 4 PR-4B-1 commits
- [ ] Local Alembic upgrade: `alembic upgrade head` → `0014` present, `validation_logs` table created, CHECK + indexes present
- [ ] Run integration: `pytest backend/tests/integration/test_validate_e2e.py -q` with Postgres + ES up → 5 tests pass (or 5 skipped if infra unreachable)
- [ ] Spot-check an accept: capture a fresh web article → wait for `status='structured'` → GET `/api/spaces/{sid}/pending` → POST `/api/spaces/{sid}/pending/{job_id}/accept-all` → confirm fact appears in `lucid_facts` ES via `client.search(index='lucid_facts', body={'query':{'match_all':{}}}, size=5)`
- [ ] Spot-check an edit: same flow but POST `/decide` with `action='edit'`, `edited_claim='...'` → confirm the persisted FactNode has `aliases=[original claim]`
- [ ] Spot-check the disambig path: seed a homonym → GET `/disambig` → POST `/resolve merge_with` → confirm queue is empty AND `validation_logs.decision_metadata` contains `{"merge_target_uid": "..."}`
- [ ] Query telemetry: `SELECT user_id, source_job_id, fact_uid, action, edited_claim_len FROM validation_logs ORDER BY validated_at DESC LIMIT 10` — confirm no claim text, no source url, no object name leaked
