# Handoff — dev inner loop

## Daily commands

```bash
# Start everything in dev mode (auto-loads docker-compose.override.yml).
# Bind-mounts the source tree + runs uvicorn --reload + next dev (HMR).
docker compose up -d

# Production shape (no override, container CMD only).
docker compose -f docker-compose.yml up -d --build

# Structural liveness — `exit 0` when wired, `exit 1` with a one-line
# failure list when something is off.
docker compose exec -T backend python -m api.ops.smoke
```

## Rebuild grades

The matrix below answers "what do I need to do after pulling this
merge". Match the change set to a grade and run the listed action.

| Grade        | Trigger                                                                       | What to run                                                                                                     |
| ------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| CODE-FE      | `frontend/web/**/*.ts(x)`, `extension/**`.                                    | Nothing. Bind mount + HMR. (`docker compose up -d` once if containers aren't running.)                          |
| CODE-BE      | `backend/api/**/*.py` (and any other `backend/**/*.py`).                      | `docker compose up -d --build backend`. ~10–20s rebuild. Bind mount + `--reload` was removed in `feat/infra-agent-isolation` (2026-06-22) — agent verification could no longer reach the live container after that. |
| DEPS         | `requirements.txt`, `package.json`, `pnpm-lock.yaml`, `Dockerfile`, `docker-compose*.yml`. | `docker compose up -d --build`. Single rebuild; named volumes (postgres / es) preserved.                         |
| MAPPING      | `backend/api/storage/elasticsearch/mappings.py` or any strict-dynamic ES change. | After the DEPS rebuild: in `backend` shell, `python -c "from api.storage.elasticsearch.indexes import reindex_all; from api.storage.elasticsearch.replay import replay_validation_logs; reindex_all(); replay_validation_logs()"`. |

When unsure for backend, default to CODE-BE (`--build backend`). For
frontend, default to CODE-FE (HMR catches it). When unsure across both,
`docker compose up -d --build` rebuilds everything.

## Override semantics

Compose loads `docker-compose.override.yml` automatically when
present. The file in this repo is GIT-TRACKED on purpose: every
developer gets the same inner loop.

- `backend`: **no override.** Backend runs the image's `CMD` (plain `uvicorn api.main:app --host 0.0.0.0 --port 8000`) in every environment. The host-bind-mount + `--reload` override was REMOVED in `feat/infra-agent-isolation` (2026-06-22) after the host-write-to-live-backend incident. Iterate via `docker compose up -d --build backend`.
- `web`: source bind-mount + anonymous volumes hiding host `node_modules` / `.next`, command swapped to `pnpm dev --hostname 0.0.0.0 --port 3000`. (Web has no equivalent attack surface — no persistent state.)
- `postgres` / `elasticsearch`: **NOT redeclared**. Stateful volumes (`postgres_data`, `es_data`) and tuned healthchecks live only in the base compose.

To run the production shape locally for a final sanity check, pass
only the base file:

```bash
docker compose -f docker-compose.yml up -d --build
```

## Smoke surface

`backend/api/ops/smoke.py` checks (in order):

1. `GET /api/health` → 200, `status=ok`.
2. `lucid_facts` / `lucid_objects` / `lucid_sources` indexes exist.
3. `lucid_facts` / `lucid_objects` counts > 0 (a `sources` count of 0 is tolerated on a fresh install).
4. `/openapi.json` is reachable and lists at least one `/api/spaces/{…}/recall` route — confirms the route is mounted without fabricating a user.

It deliberately avoids data-shape assertions ("국방부 returns N
facts"). Acceptance criteria for a PO ticket belong in the ticket's
pytest, where the contract can be locked precisely without coupling
the smoke to ephemeral content.

Override the API base if calling from the host:

```bash
LUCID_SMOKE_API=http://localhost:8000 python -m api.ops.smoke
```
