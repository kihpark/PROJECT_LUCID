# chore/lucid-web-docker-fix — single-stage Dockerfile + .dockerignore

Off `main` (commit e274f1b). Tiny follow-up branch addressing the `docker compose build web` failure surfaced in the PR-4A-1 review.

PR-4A-2 (Pending Queue + Review) is independent of this fix — they touch different file sets and can land in any order.

## Root cause

The PR-4A-1 Dockerfile is multi-stage:

```dockerfile
FROM ... AS deps
COPY package.json ./
RUN pnpm install
FROM ... AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .                            #  <-- the bug
RUN pnpm build
```

On a Windows host with pnpm's symlink-based `node_modules`, the `COPY . .` carries the host's `node_modules` into the container, **overlaying** the cleanly-installed Linux `node_modules` from the deps stage. The runner stage then reads a corrupted standalone bundle and fails:

```
Error: Cannot find module '/app/node_modules/next/dist/bin/next'
```

This is the canonical pnpm-on-Windows-in-Docker failure mode; any multi-stage variant is at risk of the same overlay without an explicit guard.

## Two changes (PO option 2 — single-stage simplification)

1. **`frontend/web/.dockerignore` (new)** — keeps host `node_modules` / `.next` / `.git` / `.env*` / `.pnpm-store` out of the container build context unconditionally. Without this, **any** Dockerfile variant on Windows is one stray `COPY . .` away from the same bug.

2. **`frontend/web/Dockerfile` (rewritten, single-stage)** — `pnpm install` + `pnpm build` run inside the container with no host node_modules anywhere on the build context. `CMD` is `pnpm start` so package.json resolves the next CLI consistently. The standalone optimisation is retained (next.config.mjs already has `output: 'standalone'`).

Production image grows by ~150-250 MB vs the planned multi-stage standalone, but stays under ~600 MB which is fine for beta. Phase 1+ revisits with a hardened multi-stage build once the install path is stable across all host OSes.

## DoD

| Check | Expected |
|-------|----------|
| `docker compose build web` | green |
| `docker compose up web` | port 3000 listens |
| `curl http://localhost:3000` | 200 (login page HTML) |
| Backend tests / lint / mypy | unchanged from main (215 / 90 / 0) |
| Vitest in CI | unchanged from PR-4A-1 |

## Commit

```
f91ded2  chore(web): single-stage Dockerfile + .dockerignore — fix node_modules clobber
```

## What this PR does NOT do

- Does NOT switch to a hardened multi-stage build — Phase 1+ scope
- Does NOT change `output: 'standalone'` in `next.config.mjs` — kept so future multi-stage can layer on it
- Does NOT touch any source files / tests — pure container-build fix

## Test plan

- [ ] `cd frontend/web && docker compose build web` — green
- [ ] `docker compose up web` — container starts, port 3000 reachable
- [ ] `curl -I http://localhost:3000/login` — HTTP 200
- [ ] `curl -I http://localhost:3000/pending` — HTTP 307 (middleware bounces unauthenticated)
- [ ] No `node_modules` from the host ends up inside the container (`docker compose exec web ls /app/node_modules/.bin/next` should resolve)
