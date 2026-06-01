# Sprint 2A PR-2A-1 — Chrome Extension scaffold + popup + auth bridge

Off `main` (commit 60b11fa, includes Sprint 4 + web docker-fix). First PR of Sprint 2A — lights up the **toolbar popup** so users can sign in (web app) and `Save current page` to `/api/capture` from any tab.

PR-2A-2 (context menu + toast) and PR-2A-3 (selection save) build on this. Together they replace the curl-only capture entry point with the real Chrome distribution surface.

## What changed

### `extension/` — new build system + 12 source files + 12 Vitest cases

| Path | Role |
|------|------|
| `manifest.config.ts` | crxjs typed manifest → `dist/manifest.json`. Manifest V3. `permissions: storage, cookies, contextMenus, activeTab, tabs`. `host_permissions: http://localhost:3000/* + http://localhost:8000/*` (production builds will add `https://*.lucid.app/*`). |
| `vite.config.ts` | `crx({ manifest })` plugin + `@` alias to `src/` |
| `vitest.config.ts` | standalone vitest config (no crxjs); jsdom env + `tests/setup.ts` mock loader |
| `tsconfig.json` | strict + `noUncheckedIndexedAccess`; `@types/chrome` makes `chrome.*` typed |
| `package.json` | pnpm@9; Vite 5 + @crxjs/vite-plugin 2 beta + Vitest 2 + `@types/chrome` |
| `.gitignore` | `dist/` + `.vite/` + `node_modules/` |
| `README.md` | quick-start + `chrome://extensions → Load unpacked` instructions |

### `extension/src/`

| Path | Role |
|------|------|
| `popup/popup.html` | 350×480 dark popup; references popup.css |
| `popup/popup.css` | wireframe-parity dark theme (`--bg-base`, `--accent-cool`) + IBM Plex Mono |
| `popup/popup.ts` | `boot()` reads cookies via `getAuth()`. Logged-out → "Open lucid.app to log in" button. Logged-in → Save current page + Open Pending Queue + Settings links. Save dispatches `chrome.runtime.sendMessage({ type:'capture', source_url, source_type })` and surfaces the result inline. |
| `background/service-worker.ts` | MV3 background module. Handles `{type:'ping'}` synchronously and `{type:'capture'}` asynchronously (returns `true` to keep the channel open while `postCapture` resolves). Caches the last 10 job_ids in `chrome.storage.local`. |
| `lib/auth.ts` | **DR-068 chrome.cookies bridge.** `getAuth()` reads `lucid_jwt` + `lucid_space_id` from `WEB_BASE` via `chrome.cookies.get`. `openLogin()` opens `WEB_BASE/login` in a new tab. |
| `lib/api.ts` | `postCapture(payload)` — `POST /api/capture` with `Authorization: Bearer`. Rejects `not_authenticated` when no JWT. Surfaces backend `detail` on non-2xx. |
| `lib/storage.ts` | `chrome.storage.local` wrapper — `readState`, `writeState` (merge-patch), `clearState`. |

### `extension/public/icons/`

16/48/128 px solid-teal (`#7be0e0`) placeholder PNGs generated with `struct + zlib` (50–300 bytes each, exact same accent-cool the web app uses). Real icons are design work post-beta.

### Tests — 12 Vitest cases (spec asked 6+)

| File | Cases |
|------|-------|
| `tests/auth.test.ts` (3) | cookie missing → null; both present → `{token, spaceId}`; reads from WEB_BASE |
| `tests/storage.test.ts` (3) | read; merge-patch write; clear |
| `tests/popup.test.ts` (3) | logged-out renders the "Open lucid.app" CTA; logged-in renders Save button + non-hidden space tag; Save click dispatches the capture message |
| `tests/api.test.ts` (3) | no JWT rejects with `not_authenticated`; Bearer + JSON body sent to `/api/capture`; backend `detail` surfaced on 4xx |

`tests/setup.ts` installs a hand-rolled `chrome.cookies / storage / runtime / tabs` mock onto `globalThis` BEFORE any module imports a `chrome.*` reference. Modules are imported lazily inside each test (`await import('@/popup/popup.ts')`) so the mock layer is always in place first.

### `docs/decision-log.md` — DR-068

> Chrome Extension auth — chrome.cookies bridge against the existing `lucid_jwt` + `lucid_space_id` cookies the web app sets at `/login` (Sprint 4A `lib/auth.setToken` / `setCurrentSpace`). The extension reads them via `chrome.cookies.get({ url: WEB_BASE, name })` and never implements its own login flow.

### `AGENTS.md` §3 — extension/ block

Full tree + the auth-bridge narrative + the capture flow path.

## DoD verified locally

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched |
| `extension/` tree | 12 source files + 12 test cases; valid 16/48/128 PNGs (`file` confirms RGBA) |

### DoD I could not verify locally
- `pnpm install` / `pnpm typecheck` / `pnpm test` / `pnpm build` — pnpm not on the dev machine
- `chrome://extensions → Load unpacked dist/` round-trip — PO QA territory
- Real cookie handoff (`/login` web → cookie → extension reads) — requires both the web dev server and the extension loaded into Chrome

## Commits

```
ac1ad3d  docs(sprint-2a-pr1): DR-068 + AGENTS §3 extension/ tree
f20c930  test(sprint-2a-pr1): 12 Vitest cases + chrome.* mock layer
40a7333  feat(sprint-2a-pr1): popup UI + service worker
6fde6b5  feat(sprint-2a-pr1): icons + lib (auth, storage, api)
fef2510  feat(sprint-2a-pr1): scaffold extension/ — Vite + @crxjs + TS + Vitest
```

## What this PR does NOT do

- Does NOT add a **context menu** ("Save to Lucid" right-click) — PR-2A-2
- Does NOT add a **content script** or in-page toast — PR-2A-2
- Does NOT add **selection-save** with surrounding context — PR-2A-3
- Does NOT replace the placeholder icons — design work post-beta
- Does NOT add an extension-side **login form** — the cookie bridge (DR-068) makes that unnecessary; the user signs in once in the web app
- Does NOT yet send the full HTML payload — `POST /api/capture` is called with `source_url` only; the extractor fetches the page server-side via `dispatch_extract`. PR-2A-2 will optionally attach the rendered DOM to skip the server fetch
- Does NOT modify the **backend** — backend tests / lint / mypy are still green at the same numbers (215 / 90 / 0)

## Sprint coordination

- **Off** `main` (commit 60b11fa)
- **No Alembic touched** — frontend-only
- **Independent of** `feat/lucid-sprint-2a-pr2` and `pr3` (stack on this once it lands)

## Test plan (PO machine)

- [ ] Branch base: `git log main..HEAD --oneline` shows the 5 PR-2A-1 commits
- [ ] `cd extension && pnpm install`
- [ ] `pnpm typecheck` → green (strict + noUncheckedIndexedAccess + `@types/chrome`)
- [ ] `pnpm test` → 12 Vitest cases pass
- [ ] `pnpm build` → `extension/dist/` materialises
- [ ] `chrome://extensions → Developer mode → Load unpacked → extension/dist/` → Lucid icon in the toolbar
- [ ] Click the icon while NOT signed in → popup shows "Open lucid.app to log in" → click → web `/login` opens in a new tab
- [ ] Sign in on the web → `lucid_jwt` + `lucid_space_id` cookies are written
- [ ] Click the toolbar icon again → popup shows the logged-in tree (Save / Pending / Settings)
- [ ] Click "Save current page" on any web page → popup surfaces `Saved as <job_id>`
- [ ] Backend: `SELECT id, status, source_url FROM source_jobs ORDER BY created_at DESC LIMIT 1` confirms the new job
- [ ] Navigate to the web `/pending` → the new job appears in the queue
