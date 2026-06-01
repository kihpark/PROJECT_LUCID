# Sprint 4A PR-4A-1 — Decide Overlay UI (Next.js 15 + Tailwind + IBM Plex)

Off `main` (commit 46272e1, includes Sprint 4B PR-4B-1). First PR of Sprint 4A — lights up the **Decide Overlay** at `/pending/{job_id}` so users can act on the PendingFacts that PR-4B-1 exposed via API.

After PR-4B-1, the Validate API is fully wired, but the only way to drive it is `curl`. **PR-4A-1 closes that gap** with the wireframe-parity UI from Pack 2 C-3 / C-4. PR-4A-2 will add the Pending Queue list + Auto-accepted tab + Review-mode notes around this.

## What changed

### `frontend/web/` — new directory, 21 files

| Path | Purpose |
|------|---------|
| `package.json` | pnpm@9 + Next 15 + React 19 + Vitest 2 + Tailwind 3 |
| `next.config.mjs` | `reactStrictMode`, `experimental.typedRoutes`, `output: 'standalone'` (Docker-friendly) |
| `tsconfig.json` | strict + `noUncheckedIndexedAccess` (safer access to `FactSummary.fact_uid \| uid`) |
| `tailwind.config.ts` | wireframe-parity colour + font tokens (`--bg-base`, `--accent-cool`, `em-person`, …) + IBM Plex via CSS vars |
| `postcss.config.js` | tailwind + autoprefixer (vanilla) |
| `vitest.config.ts` | jsdom env + `@` alias to repo root |
| `Dockerfile` | 3-stage (deps → build → run) using `node:24-bookworm` + corepack-enabled pnpm |
| `.eslintrc.json` / `.prettierrc` / `.gitignore` | standard Next + project conventions |
| `README.md` | quick-start + ad-hoc cookie-set workflow |

### `frontend/web/app/`

| Path | Role |
|------|------|
| `layout.tsx` | Loads IBM Plex Sans + Mono via `next/font/google`, pulls in `globals.css` |
| `globals.css` | Tailwind directives + the dark-theme CSS variables from `pack2-capture.html` |
| `page.tsx` | Placeholder root page; the Pending Queue lands in PR-4A-2 |
| `pending/[jobId]/page.tsx` | **Server component**. Reads JWT + space_id from cookies; fetches `GET /api/spaces/{sid}/pending/{job_id}`; renders `DecideOverlay` |
| `pending/[jobId]/loading.tsx` | Suspense fallback |
| `pending/[jobId]/error.tsx` | Error boundary with a Try-again button |

### `frontend/web/components/` — 5 files

| Component | Behaviour |
|-----------|-----------|
| `ActionButton.tsx` | 4 variants (`primary`/`secondary`/`danger`/`ghost`) + optional active ring. All other buttons inherit from this so keyboard focus is consistent |
| `LangToggle.tsx` | KR / EN switch — emits `'kr'` / `'en'` |
| `FactCard.tsx` | One PendingFact card. Shows claim (KR/EN switchable), subject / predicate / object, negation_flag warning when present (DCR-001). Edit mode opens an inline textarea + "Original preserved as alias on the persisted FactNode (DR-036)" hint. |
| `DisambigCard.tsx` | One PendingDisambig card. Shows the LLM-emitted candidate name + decision_reason, a picker list of candidate objects (name + class + score), and three action buttons (Merge / Create new / Skip). Clicking a candidate emits `merge_with` with `merge_target_uid` set. |
| `DecideOverlay.tsx` | **Client component**. Two tabs: Accept all (one-click bulk) + Review (per-card). Tracks per-fact + per-Object decisions in React state. Calls `lib/api.acceptAll` / `discardJob` / `submitDecisions`. `beforeunload` guard fires while dirty. |

### `frontend/web/lib/`

| File | Surface |
|------|---------|
| `types.ts` | Hand-mirrored from `backend/api/models/validate.py` — `FactSummary`, `ObjectSummary`, `DisambigEntry`, `PendingJobDetail`, `FactDecision`, `ObjectDecision`, `DecideRequest`, `DecideResponse` |
| `auth.ts` | `setToken` / `getToken` / `clearToken` / `isAuthenticated`. localStorage is the source of truth; a cookie mirror lets middleware see the token. **Phase 1+ swap:** httpOnly + refresh rotation |
| `api.ts` | `fetch` wrapper. Adds `Authorization: Bearer`. Throws `ApiError(status, detail)` on `!ok`; 401 auto-clears the token. Exposes `getPendingDetail` / `submitDecisions` / `acceptAll` / `discardJob` |

### `frontend/web/middleware.ts`

Gates `/pending/*` on the `lucid_jwt` cookie. Unauthenticated requests redirect to `/?login=1` (login UI is PR-4A-2 scope).

### Tests — 12 Vitest cases

| File | Cases |
|------|-------|
| `tests/FactCard.test.tsx` (5) | renders EN claim; falls back to KR when `claim_en` null; shows negation warning with scope; clicking Edit emits `action='edit'`; Accept-then-Discard sequence emits in order |
| `tests/DisambigCard.test.tsx` (3) | renders every candidate name + class/score; clicking a candidate emits `merge_with` with `merge_target_uid`; Create new emits `action='create_new'` |
| `tests/LangToggle.test.tsx` (1) | clicking EN with `value='kr'` fires `onChange('en')` |
| `tests/DecideOverlay.test.tsx` (3) | renders Accept-all tab by default; Accept all calls `api.acceptAll` once; Review-mode per-card decisions submit as a structured `DecideRequest` (accept on fn-1 + discard on fn-2; `lib/api` mocked via `vi.mock`) |

### `docker-compose.yml` — `web` service added

```yaml
web:
  build: ./frontend/web
  ports: ["3000:3000"]
  environment:
    NEXT_PUBLIC_API_URL: "http://backend:8000"
    NODE_ENV: production
  depends_on:
    - backend
```

### `AGENTS.md` §3 — full `frontend/web/` tree block

Documents the 21 files + stack (Next 15 App Router + TS strict + Tailwind + IBM Plex) + the cookie-mirror JWT pattern + the compose mount.

### `docs/decision-log.md` — DR-067

> Pending Validate data is staged in `SourceJob.extracted_metadata['structure']` JSONB, NOT in a separate `pending_facts` / `pending_objects` table … Phase 1+ may revisit if multi-worker contention or analytic-query patterns require it.

## DoD verified locally

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched by this PR |
| `frontend/web/` tree | 21 files, no `node_modules/`, no `.next/` |

### DoD I could not verify locally
- `pnpm install` — pnpm not on the dev machine; PO needs to run it once. Lockfile will land in the first install.
- `pnpm typecheck` — requires the deps to resolve `next`/`react`/etc types
- `pnpm test` — same, requires deps
- `pnpm build` — same; this also exercises the Next 15 compiler against the strict tsconfig
- Live Decide Overlay round-trip against the running backend — PR-4A-2 / PO QA territory

The integration test gap is intentional for PR-4A-1: the spec deferred Playwright E2E to Sprint 7 polish; component-level Vitest under jsdom covers the unit surface.

## Commits

```
810eee2  chore(sprint-4a-pr1): compose web service + AGENTS §3 + DR-067
e52fdeb  test(sprint-4a-pr1): 12 Vitest cases for the Decide Overlay components
6186b8b  feat(sprint-4a-pr1): Decide Overlay + FactCard + DisambigCard + LangToggle + ActionButton
613be41  feat(sprint-4a-pr1): layout + design tokens + lib (api/auth/types) + middleware
e22a5b8  feat(sprint-4a-pr1): scaffold frontend/web — Next.js 15 + TS strict + Tailwind
```

## What this PR does NOT do

- Does NOT implement the **Pending Queue list page** (`/pending`) — PR-4A-2
- Does NOT implement the **Auto-accepted tab** (Q-3) — PR-4A-2
- Does NOT implement **Review-mode graph_notes UI** — PR-4A-2 (the API endpoints already ship in PR-4B-1)
- Does NOT add a **Login page** — PR-4A-2 brings the email/password form; for PR-4A-1 the user pastes the JWT into the `lucid_jwt` cookie manually (see README)
- Does NOT add **Playwright E2E** — deferred to Sprint 7 polish per spec
- Does NOT modify the **backend** — backend tests / lint / mypy are still green at the same numbers as PR-4B-1 (215 / 90 / 0)
- Does NOT include a **lockfile** — `pnpm-lock.yaml` lands on the first install on the PO's machine

## Sprint coordination

- **Off** `main` (commit 46272e1)
- **No Alembic touched** — PR-4A-1 is frontend-only
- **Stacked-on:** none; PR-4A-2 (Pending Queue + Review mode + Auto-accepted) will rebase off `main` once this lands

## Test plan

- [ ] Branch base: `git log main..HEAD --oneline` shows the 5 PR-4A-1 commits
- [ ] On PO machine: `cd frontend/web && pnpm install`
- [ ] `pnpm typecheck` → green (Next 15 + React 19 types resolve, strict + noUncheckedIndexedAccess pass)
- [ ] `pnpm test` → all 12 Vitest cases pass
- [ ] `pnpm build` → green (Next 15 prod build under output:standalone)
- [ ] `docker compose up web` → container builds, port 3000 reachable
- [ ] Manual: log in via API → set `lucid_jwt` + `lucid_space_id` cookies → visit `/pending/<job_id>` → see the Decide Overlay → click Accept all → confirm fact appears in `lucid_facts` ES
- [ ] Manual: same flow, click Review tab → mix Accept / Edit / Discard → Submit → confirm `validation_logs` has one row per action with no claim text leak
- [ ] Manual: open a job with disambiguation → click a candidate → Submit → confirm queue is empty + `validation_logs.decision_metadata` carries `{"merge_target_uid": "..."}`
