# Lucid Chrome Extension

Sprint 2A PR-2A-1 — Manifest V3 + popup + service worker.

Stack: Vite + @crxjs/vite-plugin + TypeScript strict + Vitest 2.

## Quick start

```sh
pnpm install
pnpm build       # writes dist/ for Chrome to load
pnpm dev         # watches src/ and rebuilds dist/ on change
pnpm test        # Vitest under jsdom
pnpm typecheck   # tsc --noEmit
```

## Load into Chrome (PO verification)

1. `pnpm build` (writes dist/)
2. Open `chrome://extensions`
3. Toggle **Developer mode** (top-right)
4. **Load unpacked** → select `extension/dist/`
5. The Lucid icon appears in the toolbar.

## Auth flow (DR-068 — chrome.cookies bridge)

The web app (`/login`) sets a non-httpOnly `lucid_jwt` cookie via
`lib/auth.setToken()`. The extension service worker reads that cookie
via `chrome.cookies.get({ url, name: 'lucid_jwt' })` instead of
implementing a separate OAuth flow.

1. User clicks the toolbar icon
2. Popup checks `chrome.cookies` for `lucid_jwt` and `lucid_space_id`
3. If missing: popup shows "Open lucid.app to log in" button →
   opens `http://localhost:3000/login` in a new tab
4. After login the web app writes the cookies; popup re-reads them on
   next open and switches to the logged-in state

Phase 1+ moves to httpOnly cookies + a dedicated OAuth-style handoff.

## Save current page

The toolbar popup's "Save current page" button:

1. Reads the active tab URL via `chrome.tabs.query({ active: true })`
2. Sends `{ type: 'capture', source_url, source_type }` to the
   service worker via `chrome.runtime.sendMessage`
3. Service worker fetches `POST /api/capture` with
   `Authorization: Bearer <lucid_jwt>` and the `lucid_space_id`
4. Popup surfaces the resulting `job_id` + capture state
