# feat/count-source-unification — Discovery

## PO's live evidence (2026-06-23)

DB state for PO's user:
- `source_jobs.status='structured'` total: **7**
- of those, `extracted_metadata.structure.fact_count > 0`: **5** (16, 15, 12, 14, 25 facts)
- of those, `fact_count = 0`: **2** (legacy LLM parse failures, no structure rows extracted)

PO's actual screen showed **THREE different numbers**:
- AppShell "검증(4)" tab badge: **4**
- HomePage "검증 대기 7건" copy: **7**
- `/pending` page list: **1** job actually rendering

PO directive: "실시간적으로 사용자에게 전달하는 정보는 일관되게 제공되어야 한다."

The correct number, per PO: count of **decide-ready jobs** = `status='structured' AND fact_count > 0 AND has-undecided-fact` → **5**.

---

## 0.1 The THREE count call sites

### A. AppShell badge "검증(N)"
- **File**: `frontend/web/components/AppShell.tsx:377` (NavLink with `count: pendingCount`)
- **Hook**: `frontend/web/components/AppShell.tsx:357` → `useHomeBrief().pendingCount`
- **Hook impl**: `frontend/web/lib/useHomeBrief.ts:40` → `brief.pending_validation`
- **Endpoint**: `GET /api/home/brief` → field `pending_validation`
- **Backend impl**: `backend/api/routes/home.py:158-177` `_pending_validation_count` — counts SourceJobs with `status='structured'` (no fact_count filter)
- **Result for PO**: 7 (but PO saw 4 because of stale fetch from before a wipe — AppShell only fetches on mount, never refreshes)

### B. HomePage "검증 대기 N건" copy
- **File 1**: `frontend/web/components/HomePage.tsx:725` `ActiveBriefing pending={brief.pending_validation}` → "어제 캡처하신 N건이 검증을 기다리고 있습니다."
- **File 2**: `frontend/web/components/HomePage.tsx:368,432` `TodayBriefingCard pending={brief.pending_validation}` → "검증 대기 N건"
- **Hook**: same `useHomeBrief()` instance per component mount
- **Endpoint**: same `GET /api/home/brief` → `pending_validation`
- **Result for PO**: 7 (since HomePage was freshly mounted after the page load)

### C. /pending list endpoint
- **Route**: `backend/api/routes/validate.py:150` `@router.get("/pending")` → `GET /api/spaces/{space_id}/pending`
- **Filter 1** (line 167-171): `WHERE knowledge_space_id = ks.id AND status = 'structured'` → 7 rows
- **Filter 2** (line 210-211): `summaries = [_job_summary(j) for j in rows]; summaries = [s for s in summaries if s.fact_count > 0]`
- **`_job_summary` `fact_count`** (line 97-143): `total_facts - len(decided_fact_uids that match facts_summary)` — i.e. PENDING facts, not all facts
- **Result for PO**: 5 jobs have `extracted_metadata.structure.fact_count > 0`, but the per-job summary subtracts already-decided facts → if 4 of those have all-decided facts left, only 1 remains.

### Why the three numbers desync (one-line)

`home.py::_pending_validation_count` counts ALL `status='structured'` (no fact filter); the /pending list filters down to jobs with **un-decided** facts; the AppShell badge serves a cached fetch from before the user's last decisions.

---

## 0.2 The ONE TRUE COUNT — "decide-ready"

A SourceJob is **decide-ready** iff:

1. `user_id` matches the caller, `knowledge_space_id` matches the active KS
2. `status = 'structured'` (LLM extraction succeeded, structure was emitted)
3. `extracted_metadata.structure.fact_count > 0` (something was decomposed; LLM didn't return an empty list)
4. The job has at least one **un-decided fact** — i.e. `len(facts_summary) - len(decided_fact_uids ∩ facts_summary.uids) > 0`

Criterion (3) excludes the 2 PO jobs with legacy parse failures (fact_count=0).
Criterion (4) excludes jobs where the user already decided every fact (they're effectively "complete", just waiting for the cleanup transition).

For PO's current DB, this yields **5** before any decisions, dropping to whatever remains as the user submits.

### Why fact_count > 0 belongs in the ONE TRUE FILTER

PO's mental model of "지금 검증" (validate now) is: jobs where the AI has produced something I can decide on. A job with `fact_count=0` (legacy LLM JSON-parse failure) gives the user nothing to decide. Surfacing it as "7건 대기" makes the surface lie — when the user clicks "지금 검증", they only see 1 job, not 7.

### Legacy fact_count=0 jobs

The 2 jobs with `fact_count=0` shouldn't be silently deleted (PO might want to revisit / retry extract). They're filtered out of the decide-ready count and the /pending list. A future PR can surface them as "처리 실패: N건 → 재시도 / 삭제" on a separate strip. For now: they're invisible on home/pending but still in DB.

---

## 0.3 Why /pending shows 1 not 5

The /pending list correctly uses `fact_count > 0`. The remaining drop from 5→1 happens in `_job_summary` (validate.py:97-143), which computes `pending_count = total_facts − len(decided_fact_uids)`. Then line 211 drops every summary with `fact_count == 0`. So jobs where the user already decided EVERY fact (but the SourceJob.status hasn't transitioned out of 'structured' yet — the lifecycle update happens elsewhere) get filtered.

This is **the existing correct behavior of the list** — what makes it inconsistent is that the COUNT doesn't apply the same filter. The list is "right" by PO's definition; the count is "wrong" because it includes legacy + fully-decided jobs.

---

## Fix shape

1. New helper `_decide_ready_jobs(session, user_id, ks_id)` in `home.py` that applies:
   - `user_id`, `knowledge_space_id`, `status='structured'`, JSONB `fact_count > 0`
2. `_pending_validation_count` calls `_decide_ready_jobs(...).count()` for criteria (1)+(2)+(3). 
3. Criterion (4) ("un-decided facts remain") is per-row JSONB inspection — too expensive to push into SQL for the count path. We approximate by counting `fact_count > 0` jobs and trust the list's narrower filter; the worst case is the count being 1 higher than the list when every fact in a job has been decided but `status` hasn't transitioned. PO accepts this as a temporary gap (status transition is a separate cleanup issue).
4. `/pending` list (`validate.py::list_pending`) imports the same `_decide_ready_jobs` helper for its prefilter. Per-row `_job_summary` continues to drop fully-decided jobs (criterion 4) — that's not a desync, it's the same direction of filtering, just with one extra step.
5. AppShell-level staleness is partially mitigated by the existing `Cache-Control: no-store` on /home/brief (entity-restore PR). The deeper "AppShell fetches once on mount" problem is out of scope here — PO's test will be: navigate to /home, see 5, navigate to /pending, see 5.

---

## Constraints honored

- No wipe-script changes.
- No `validation_logs` semantics changes.
- No assistant route, no recall route touched.
- The 2 fact_count=0 jobs stay in DB.
- No new caching layer added; the existing `Cache-Control: no-store` from entity-restore handles the wipe-immediate-count case.
