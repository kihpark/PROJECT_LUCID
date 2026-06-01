# chore/lucid-decide-overlay-fetch-fix — SSR fetch diagnostics for /pending/[jobId]

Off `main`. Tiny follow-up branch addressing the **opaque "fetch failed"** PO surfaced during Walking-Skeleton Iteration 1 verification of `/pending/[jobId]`.

## Diagnosis

Node 18+ `fetch` (undici) wraps the real network error in a `TypeError` whose useful info hides in `error.cause`. Without extracting it, the on-page message gave nothing to act on — could be any of:

- `ECONNREFUSED` (backend not running)
- `EAI_AGAIN` / `ENOTFOUND` (DNS or IPv6 `localhost`-vs-`::1` surprise)
- the wrong `NEXT_PUBLIC_API_URL` at SSR time
- a stale cookie carrying a bogus Bearer header (HTTP 401)
- the spaceId cookie pointing to a deleted KnowledgeSpace (HTTP 403)

Without separating these on the page, walking-skeleton verification stalls every time.

## Three changes

1. **`frontend/web/lib/server-fetch.ts` (new)** — `ssrJson<T>(path, { token, method })` centralises the SSR backend fetch:

   - reads `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`)
   - extracts `error.cause.code` (`ECONNREFUSED` / `EAI_AGAIN` / etc) **and** `error.cause.message`
   - logs `[ssr-fetch] FAIL <method> <url> (<code>) <message>` to `console.error` so the `pnpm dev` terminal carries the diagnostic
   - throws a typed `ServerFetchError` carrying `{ url, apiBase, causeCode }`
   - `401`/`403` → "API rejected the session — sign in again" instead of being swallowed as a generic 500
   - `404` → returns `null` (page calls `notFound()`)
   - other `!ok` → "API returned HTTP `<n>` for `<url>` — `<detail>`" where `detail` is the FastAPI `detail` field if present
   - exports `apiBase()` so the page UI can show what was tried

2. **`frontend/web/app/pending/[jobId]/page.tsx`** — drops its own `loadDetail()` and calls `ssrJson` directly. On error renders:

   - a header "Could not load the Decide Overlay"
   - the (now actionable) error message
   - a hint that the API base lives in `NEXT_PUBLIC_API_URL` with the current value shown so PO can immediately see whether it's misconfigured

3. **`frontend/web/app/pending/[jobId]/review/page.tsx`** — same refactor + same UI.

## Expected outcomes after this lands

The next Walking-Skeleton run will show one of these precise messages instead of "fetch failed":

```
Could not reach API (ECONNREFUSED). Tried http://localhost:8000/api/spaces/<sid>/pending/<jid>.
Could not reach API (ENOTFOUND). Tried http://backend:8000/api/...
Could not reach API (UND_ERR_CONNECT_TIMEOUT). Tried http://localhost:8000/api/...
API rejected the session (HTTP 401). Sign in again.
API returned HTTP 403 for http://localhost:8000/api/spaces/<sid>/pending/<jid> — forbidden.
API returned HTTP 404 for http://localhost:8000/api/spaces/<sid>/pending/<jid> — job_not_found.
```

PO can then act on whichever message lands instead of guessing.

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched |
| Web typecheck/test/build (PO) | should remain green; the page components have the same exports + same render branches |

## Commit

```
36fd560  chore(web): SSR fetch diagnostics — surface undici cause + API base on failure
```

## What this PR does NOT do

- Does NOT identify the root cause — that's what the better diagnostics will surface on the next walking-skeleton iteration
- Does NOT change the API contract or the backend
- Does NOT migrate `lib/api.ts` (client-side fetch) to the helper — that fetch runs in the browser and has different failure modes (CORS) plus its own error UI
- Does NOT add automated tests — these pages are server components; the failure modes are network-level

## Test plan (PO machine)

- [ ] `cd frontend/web && pnpm typecheck && pnpm test && pnpm build` → unchanged, all green
- [ ] `pnpm dev` → visit `/pending/<some-job-id>` while backend is **down** → page shows "Could not reach API (ECONNREFUSED). Tried http://localhost:8000/...", and the `pnpm dev` terminal shows the same with `[ssr-fetch]` prefix
- [ ] Bring backend up but use an expired/invalid JWT cookie → page shows "API rejected the session (HTTP 401). Sign in again."
- [ ] With backend up + valid auth → page loads normally
- [ ] Walking-Skeleton Iteration 2 — whichever specific message lands, PO can grep `[ssr-fetch]` in the dev terminal for the SSR-side context
