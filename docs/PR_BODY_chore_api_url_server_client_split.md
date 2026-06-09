# chore/lucid-api-url-server-client-split — INTERNAL_API_URL for SSR, NEXT_PUBLIC for browser

Off `main`. Walking-Skeleton Iteration 2 Bug 2.

The fetch diagnostics from `chore/lucid-decide-overlay-fetch-fix` worked exactly as intended — they surfaced the precise root cause:

```
Could not reach API (ECONNREFUSED).
Tried http://localhost:8000/api/spaces/<sid>/pending/<jid>.
```

…which exposed the canonical Next.js Docker SSR mismatch.

## Diagnosis

Inside the web Docker container, `localhost:8000` resolves to the web container itself — **not** the backend container — so Next.js SSR `fetch()` from `/pending/[jobId]/page.tsx` got ECONNREFUSED.

The browser side has no problem: the browser sees `localhost:8000` as the host machine's port-mapped backend (`8000:8000`). But the SSR runtime executes inside the docker network, where the backend's hostname is `backend:8000`.

## Fix

Three changes:

### 1. `docker-compose.yml` — split the web service's API base

```yaml
web:
  environment:
    NEXT_PUBLIC_API_URL: "http://localhost:8000"   # browser-side (port-mapped host)
    INTERNAL_API_URL:    "http://backend:8000"     # server-side SSR (docker DNS)
```

`NEXT_PUBLIC_*` is inlined at build time and reaches the browser; `INTERNAL_API_URL` only the Node runtime inside the container reads.

### 2. `frontend/web/lib/server-fetch.ts` — `apiBase()` is context-aware

```ts
export function apiBase(): string {
  if (typeof window === 'undefined') {
    return (
      process.env.INTERNAL_API_URL
      || process.env.NEXT_PUBLIC_API_URL
      || 'http://localhost:8000'
    );
  }
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
}
```

The dual branch keeps the helper safe if a future client component ever imports it — INTERNAL_API_URL points at a hostname only the docker network can resolve and would be useless in the browser.

The `pnpm dev` host-development case (no docker) still works: `INTERNAL_API_URL` is unset, so the chain falls through to `NEXT_PUBLIC_API_URL` (or the default).

### 3. `frontend/web/lib/api.ts` — drop dead `window.location.origin` branch

`NEXT_PUBLIC_API_URL` is inlined at build time so the
`window.location.origin` fallback in the precedence ladder was dead code. Symmetric with `server-fetch.ts`:

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
```

## Combined effect (with chore 3)

With the link-routing fix already in `chore/lucid-pending-link-routing-fix` and this PR landing alongside, the Walking-Skeleton chain finally connects end-to-end:

```
/pending  ->  /pending/<UUID>   (chore 3 — Link href substitution)
          ->  Decide Overlay loads via SSR fetch
              -> http://backend:8000  inside docker (this PR)
              -> http://localhost:8000  on host pnpm dev (this PR)
```

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched |
| `pnpm test` (PO) | unchanged from main (the server-fetch helper has no Vitest cases; SSR is integration territory) |

## Commit

```
853e250  chore(web): split API base — INTERNAL_API_URL for SSR, NEXT_PUBLIC for browser
```

## What this PR does NOT do

- Does NOT migrate the extension's `WEB_BASE` constant — extensions don't run inside the docker network
- Does NOT add a Vitest case for the context branch — `typeof window === 'undefined'` switch is jsdom-mocked at the wrong layer to be useful; integration territory
- Does NOT change client-side fetch behaviour — `lib/api.ts` simplification is precedence-equivalent

## Test plan

- [ ] `cd frontend/web && pnpm test && pnpm build` → unchanged from main
- [ ] PO host (`pnpm dev` + backend in docker): `/pending/<UUID>` loads — both NEXT_PUBLIC_API_URL and INTERNAL_API_URL fall through to `http://localhost:8000` since INTERNAL_ isn't set on the host
- [ ] PO docker (`docker compose up`): `/pending/<UUID>` loads — SSR uses `http://backend:8000`, browser uses `http://localhost:8000`. The fetch diagnostic `[ssr-fetch]` log line shows `backend:8000` in the dev console
- [ ] After both PRs merge (chore 3 + this): `/pending` → click card → URL is `/pending/<UUID>` → Decide Overlay renders the facts
