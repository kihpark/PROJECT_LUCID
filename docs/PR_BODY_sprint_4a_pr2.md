# Sprint 4A PR-4A-2 — Pending Queue (Q-1) + Review Mode (Q-2) + Auto-accepted placeholder (Q-3) + Login

Off `main` (commit e274f1b, includes Sprint 4A PR-4A-1). Second PR of Sprint 4A — completes the Validate UI surface so users can land on `/login`, browse `/pending`, and decide with notes in `/pending/[jobId]/review`.

After PR-4A-1, the only way to reach the Decide Overlay was to paste a JWT into the `lucid_jwt` cookie by hand and visit `/pending/<job_id>` directly. **PR-4A-2 closes that gap** with a real login form, a queue list with filters + paging, and an inline GraphNoteEditor for Review-mode personal notes. The Q-3 Auto-accepted tab is a placeholder because the backing endpoint is Sprint 5 scope (trusted-source policy).

## What changed

### Routes — 4 new pages

| Path | Type | Purpose |
|------|------|---------|
| `app/login/page.tsx` | server | renders `<LoginForm/>` |
| `app/pending/page.tsx` | server | reads `lucid_space_id` cookie, renders `<PendingQueueView/>` |
| `app/pending/[jobId]/review/page.tsx` | server | re-uses `<DecideOverlay reviewMode/>` so each FactCard shows `<GraphNoteEditor/>` |
| `app/pending/auto-accepted/page.tsx` | static | Q-3 placeholder — links back to `/pending`, names the missing endpoint explicitly |

### Components — 5 new + 2 extended

| Component | Behaviour |
|-----------|-----------|
| `LoginForm.tsx` | email + password → `loginUser()` → `getMySpaces()` → `setCurrentSpace(spaces[0])` → `router.push('/pending')`. Rejects accounts with no KS (registration always provisions one). Surfaces `ApiError.detail` on 401. |
| `PendingFilters.tsx` | `source_type` select + `has_negation` / `has_disambig` checkboxes + Apply / Reset. Reset clears filters but preserves the page-size limit. |
| `PendingQueueList.tsx` | card-per-job grid + totals line + prev/next pagination. Card surfaces source URL, source_type chip, captured timestamp, fact/object counts, and the wireframe ⚠ negation / ⚡ disambig indicators. Empty state: dashed CTA. |
| `PendingQueueView.tsx` | client wrapper that owns filter + page state, calls `lib/api.listPending` on every change, surfaces `ApiError.detail` inline, links to `/pending/auto-accepted`. |
| `GraphNoteEditor.tsx` | `listNotes()` on mount; inline textarea (8000-char cap, matches `GraphNoteCreateRequest`); per-note Delete; surfaces `ApiError.detail`. |
| `FactCard.tsx` (extended) | new optional props `reviewMode + spaceId`. When both set, renders `<GraphNoteEditor/>` below the action row. Default `false` keeps the PR-4A-1 Decide Overlay surface unchanged. |
| `DecideOverlay.tsx` (extended) | new optional prop `reviewMode`. When true the initial tab flips to Review and threads `reviewMode + spaceId` into every `<FactCard/>`. |

### `lib/` — 3 modules extended

`types.ts` gains `PendingJobSummary`, `PendingPage`, `PendingListFilters`, `GraphNote`, `LoginRequest`, `LoginResponse`, `KnowledgeSpacePublic`.

`api.ts` gains:
- `loginUser(payload)` → `POST /api/auth/login`
- `getMySpaces()` → `GET /api/spaces/me`
- `listPending(spaceId, filters)` → `GET /api/spaces/{sid}/pending`
- `listNotes(spaceId, factUid)` → `GET .../facts/{uid}/notes`
- `createNote(spaceId, factUid, note)` → `POST .../facts/{uid}/notes`
- `deleteNote(spaceId, factUid, noteId)` → `DELETE .../facts/{uid}/notes/{id}`

Plus a `buildPendingQuery` helper that drops `undefined`/`null`/`''` from URLSearchParams (so an unset filter never becomes `&source_url=`).

`auth.ts` gains `setCurrentSpace` / `getCurrentSpace` / `clearCurrentSpace` (mirrors a `lucid_space_id` cookie so server components and middleware can read the active KS alongside the JWT).

### Tests — 8 new Vitest cases (total now 20)

| File | Cases |
|------|-------|
| `tests/PendingQueueList.test.tsx` (3) | renders one card per job + totals; ⚠/⚡ indicators conditional on the booleans; Next button calls `onPage(offset + limit)` |
| `tests/PendingFilters.test.tsx` (2) | Apply emits filters with `offset=0` (clears paging on filter change); Reset clears filters but preserves limit |
| `tests/GraphNoteEditor.test.tsx` (3) | lists existing notes on mount; Add → createNote() → rerender; Delete → deleteNote() → rerender |

### `AGENTS.md` §3 frontend/web/ block

Extended with all PR-4A-2 routes / components / tests + a "Q-3 backend gap" note explaining the Auto-accepted placeholder.

## DoD verified locally

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched by this PR |
| `frontend/web/` tree | 12 modified + 11 new files; no `node_modules/`, no `.next/` |

### DoD I could not verify locally
- `pnpm typecheck` / `pnpm test` / `pnpm build` — pnpm not on the dev machine; PO needs to run them
- Live login → queue → review → note round-trip — PO QA territory
- The Q-3 backend gap explicitly: no test in this PR exercises `validation_method=auto` because the endpoint doesn't exist (that's the whole reason `/pending/auto-accepted` is a placeholder)

## Commits

```
5e950e9  docs(sprint-4a-pr2): AGENTS §3 frontend/web/ block — Queue + Review + Notes
4305f6c  test(sprint-4a-pr2): 8 Vitest cases for Queue + Filters + GraphNoteEditor
fe2bbe2  feat(sprint-4a-pr2): /pending/auto-accepted placeholder (Q-3)
64cb55d  feat(sprint-4a-pr2): /pending/[jobId]/review + GraphNoteEditor (Q-2)
315f275  feat(sprint-4a-pr2): /pending Pending Queue list (Q-1)
66bde62  feat(sprint-4a-pr2): /login page + LoginForm
17d884b  feat(sprint-4a-pr2): extend lib with PR-4A-2 shapes + endpoints + space cookie
```

## What this PR does NOT do

- Does NOT implement the real Auto-accepted list — Sprint 5 brings the trusted-source policy + the backing `GET /facts?validation_method=auto` endpoint
- Does NOT add a registration form — the API supports it (POST `/api/auth/register`), but UI for it is post-beta polish
- Does NOT add OAuth / magic-link / SSO — beta is email + password
- Does NOT add a logout button — for beta the user clears the `lucid_jwt` cookie manually or `clearToken()` from devtools; logout UI lands with the Settings page in a later sprint
- Does NOT modify the **backend** — backend tests / lint / mypy are still green at the same numbers as PR-4B-1 (215 / 90 / 0)
- Does NOT fix the `docker compose build web` issue surfaced in PR-4A-1 review — separate `chore/lucid-web-docker-fix` PR follows (Dockerfile simplification, option 2 from the PO spec)

## Sprint coordination

- **Off** `main` (commit e274f1b)
- **No Alembic touched** — frontend-only
- **Next:** `chore/lucid-web-docker-fix` (single-stage Dockerfile to unblock `docker compose up web`), then Sprint 5 (trusted-source policy + Q-3 backing endpoint + Auto-accepted real implementation)

## Test plan

- [ ] Branch base: `git log main..HEAD --oneline` shows the 7 PR-4A-2 commits
- [ ] On PO machine: `pnpm install && pnpm typecheck && pnpm test && pnpm build` — all green
- [ ] Manual: `/login` accepts a valid email/password → redirect to `/pending`
- [ ] Manual: `/login` rejects bad credentials → error message shown
- [ ] Manual: `/pending` lists structured jobs; filter by source_type / has_negation / has_disambig works; prev/next pagination correct
- [ ] Manual: card click navigates to `/pending/[jobId]` (Decide Overlay) — PR-4A-1 surface still works
- [ ] Manual: visit `/pending/[jobId]/review` — Review tab is active by default; each FactCard shows a Notes section with existing notes + a textarea + Add + per-note Delete
- [ ] Manual: GraphNoteEditor — Add a note → it appears in the list; Delete → it disappears; backend `graph_notes` row count matches
- [ ] Manual: `/pending/auto-accepted` shows the placeholder card with the Sprint 5 notice + a link back to `/pending`
- [ ] No `pending_jwt`? — `/pending/*` redirects to `/?login=1` (middleware enforcement, PR-4A-1 behaviour preserved)
