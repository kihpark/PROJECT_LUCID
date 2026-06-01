# Sprint 2A PR-2A-2 — Context menu (page / selection / image) + in-page Toast with status polling

Off `main` (commit cb8048f, includes PR-2A-1). Second PR of Sprint 2A — replaces the popup-only capture entry point with the right-click flow the wireframes call for (Pack 2 C-1, C-2) and an in-page toast that walks the user through the full CSVS lifecycle.

After PR-2A-1, the only way to save was the toolbar popup. **PR-2A-2 adds three context-menu items + a 5-state toast** so capture works from any page, on the page (no popup-modal feel), with live status feedback. PR-2A-3 builds selection prefix/suffix context on top of this.

## What changed

### `extension/manifest.config.ts`

| Field | Update |
|-------|--------|
| `permissions` | `+ 'scripting'` |
| `content_scripts` | new entry: `matches: ['<all_urls>']`, `run_at: 'document_end'`, `js: ['src/content/toast.ts']`, `css: ['src/content/toast.css']` |

### `extension/src/background/`

| File | Role |
|------|------|
| `context-menu.ts` (new) | Registers three items (`lucid-save-{page,selection,image}`). `handleContextMenuClick(info, tab)` builds the payload, runs `postCapture`, and on success notifies the tab via `chrome.tabs.sendMessage(tabId, { type: 'show_toast', job_id, status: 'pending_extract' })`. `chrome://` tabs (no content script) silently skip the toast. |
| `service-worker.ts` (extended) | `onInstalled` now calls `installContextMenus()`; module-level `installContextMenuListener()` wires `onClicked`. `onMessage` gains two async handlers: `get_job_status` → `getJobStatus(job_id)` and `get_structured_summary` → `getStructuredSummary(job_id)`. Both return `true` to keep the message channel open until `fetch` resolves. |

### `extension/src/lib/api.ts` — two new helpers

```ts
getJobStatus(jobId): Promise<JobStatusResponse>          // GET /api/jobs/{job_id}
getStructuredSummary(jobId): Promise<StructuredSummary>  // GET /api/spaces/{sid}/pending/{job_id}
```

Both surface the backend's `detail` on 4xx. The summary helper resolves the user's `space_id` via `getAuth()` so the content script doesn't need to know it.

### `extension/src/content/` (new directory)

| File | Role |
|------|------|
| `toast.css` | `.lucid-toast-*` scoped styles. Fixed bottom-right, `z-index: 2147483647` to survive page resets, 240 ms opacity + translate fade. Same colour tokens as the web app (`--bg-base`, `--accent-cool`). |
| `toast.ts` | Content script — registers a single `chrome.runtime.onMessage` listener (guarded with `window.__lucidToastInstalled` so re-evaluation doesn't double-subscribe). |

**Toast lifecycle:**

1. `chrome.runtime.onMessage` receives `{ type: 'show_toast', job_id, status, error }`
2. `renderInitial(status, job_id, error)` paints one of five labels:

   | Status | Label | Detail |
   |--------|-------|--------|
   | `pending_extract` / `extracting` | Saving to Lucid... | `job ${jobId.slice(0,8)}` |
   | `extracted` / `structuring` | Analyzing... | `job ${jobId.slice(0,8)}` |
   | `structured` | Saved to graph | Review → link |
   | `*_failed` / `capture_failed` | Save failed *(error class)* | `error_message` or "Retry from the popup." |
   | (post-timeout) | Still working | "Check the Pending Queue for the latest status." |

3. If status is non-terminal AND `job_id` is present, `startPolling(jobId)` opens a **1 s** interval that sends `{ type: 'get_job_status', job_id }` to the service worker (mediated to avoid host-page CORS).
4. Up to **POLL_MAX_ATTEMPTS=60** ticks (~60 s).
5. Once `status='structured'`, one extra `{ type: 'get_structured_summary', job_id }` runs to learn `fact_count`; the toast then renders `N facts found  Review →`.
6. Terminal states freeze the toast and schedule a 5 s fade-out (`FADE_OUT_MS`).
7. A fresh `show_toast` for a new capture cancels any pending fade and resets state.

The `__test__` export surface gives Vitest direct access to `renderInitial / startPolling / reset` etc.

### Tests — 7 new Vitest cases (total now **19**)

| File | Cases |
|------|-------|
| `tests/context-menu.test.ts` (3) | `installContextMenus()` creates exactly the three expected items; page click dispatches a `web_article` payload + `show_toast` to the tab; selection click dispatches `highlighted_text` with a non-empty `raw_payload_b64` |
| `tests/toast.test.ts` (4) | `Saving to Lucid...` initial render with truncated job_id; `Save failed` render with the `lucid-toast-error` class; polling stops when `get_job_status` returns `structured`; polling stops after 60 ticks with the `Still working` fallback |
| `tests/setup.ts` (extended) | Adds the `chrome.contextMenus` mock surface (`create / removeAll / onClicked`) |

### `AGENTS.md` §3 extension/ block

Header now reads "Sprint 2A PR-2A-1 + PR-2A-2". `background/` shows both `service-worker.ts` (with the two new handlers) and the new `context-menu.ts`. New `content/` subtree. Tests file count updates to 19. New **Capture flow (context menu, PR-2A-2)** subsection diagrams the right-click → `postCapture` → `chrome.tabs.sendMessage` → toast polling chain.

## DoD verified locally

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched |
| `extension/` tree | 4 new source files + 2 new test files + 4 modified files |

### DoD I could not verify locally
- `pnpm install` / `pnpm typecheck` / `pnpm test` / `pnpm build` — pnpm not on the dev machine
- `chrome://extensions → Reload → right-click → Save to Lucid` round-trip — PO QA territory
- The live toast polling against a real backend `process_source_job` cycle — PR-3-3's daemon-thread structure dispatch means the user will actually see the `extracted → structuring → structured` transitions

## Commits

```
afd9fd9  docs(sprint-2a-pr2): AGENTS §3 extension/ — context menu + content/ + capture flow
d9bd67b  test(sprint-2a-pr2): 7 Vitest cases for context menu + toast (total 19)
10b428c  feat(sprint-2a-pr2): in-page toast — 5-state polling UI
5ce2845  feat(sprint-2a-pr2): context menu + SW handlers for status polling
```

## What this PR does NOT do

- Does NOT add **selection prefix/suffix context** — PR-2A-3 walks ±1 sentence around the selection so the captured highlighted_text has provenance context
- Does NOT add a **logout** menu item — the cookie bridge means logout is a web-side action
- Does NOT add a **dismiss** button to the toast — auto fade-out + the next capture replacing the previous toast is enough for beta; explicit dismiss lands in Sprint 7 polish
- Does NOT add a **Shadow DOM** isolation for the toast — beta uses scoped classes + max z-index; if hostile pages break the toast, Shadow DOM is the polish-stage answer
- Does NOT extend the backend — `POST /api/capture` + `GET /api/jobs/{id}` + `GET /api/spaces/{sid}/pending/{id}` already cover the surface

## Sprint coordination

- **Off** `main` (commit cb8048f, includes PR-2A-1)
- **No Alembic touched** — extension-only
- **PR-2A-3 (selection prefix/suffix)** will stack on this once it lands

## Test plan (PO machine)

- [ ] Branch base: `git log main..HEAD --oneline` shows the 4 PR-2A-2 commits
- [ ] `cd extension && pnpm install && pnpm typecheck && pnpm test && pnpm build`
- [ ] `chrome://extensions → Reload Lucid` (the new manifest content_scripts entry needs a reload)
- [ ] Visit any web page → right-click on the body → **Save page to Lucid** → toast appears bottom-right with "Saving to Lucid... job XXXXXXXX"
- [ ] Wait — toast transitions through "Analyzing..." and finally "N facts found  Review →"
- [ ] Click "Review →" → opens `http://localhost:3000/pending/{job_id}` in a new tab
- [ ] Right-click on a text selection → **Save selection to Lucid** → toast pops; `source_jobs.source_type='highlighted_text'`; `raw_payload` is the base64 of the selection
- [ ] Right-click on an image → **Save image to Lucid** → toast pops; `source_jobs.source_type='image'`; `source_url` is the image URL
- [ ] Trigger a backend failure (kill the API mid-extract) → toast freezes on "Save failed" with the error string
- [ ] Throttle the structure stage (slow Claude API) → toast stays in "Analyzing..." for >60 s → freezes on "Still working" + Pending Queue notice
- [ ] No toast on `chrome://` pages (content script isn't injected) — capture still succeeds, the toast just doesn't render
