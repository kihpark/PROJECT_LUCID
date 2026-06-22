# Infra Agent Isolation — Manual Post-Merge Smoke

After this PR merges, PO must run these three checks on `main` to confirm
the backend container is fully isolated from host writes.

## Prereq

```bash
git pull
docker compose up -d --build backend
# Wait ~10-20s for the backend service to come back up.
docker compose ps backend
# Expect: lucid-backend-1   Up X seconds (healthy)
```

## Smoke 1 — host edit must NOT reach the container

The whole point of this PR.

```bash
# 1. Add a unique marker to a tracked backend file on the host.
echo "# infra-isolation-marker-$(date +%s)" >> backend/api/main.py

# 2. Check the container's view of the same path.
docker compose exec backend grep "infra-isolation-marker" /app/api/main.py
# EXPECTED: no match (exit 1). The container's /app/api/main.py is the
# image's copy and the host edit is invisible.

# 3. Revert the host file.
cd backend && git checkout api/main.py && cd ..
```

If grep returns a match in step 2, the bind-mount is still active —
something went wrong with the override edit. Fix:
`git log -1 docker-compose.override.yml` and confirm the backend block
is gone.

## Smoke 2 — backend tests pass against IMAGE code

```bash
docker compose exec -T backend python -m pytest -q
# EXPECTED: same green as pre-merge baseline (target ~839 passed —
# 836 baseline + 3 new infra isolation cases gated on
# LUCID_INFRA_ISOLATION_VERIFY=1, so those skip and the count stays
# ~836-838 depending on which optional suites run).
```

## Smoke 3 — live Claude smoke (only before shipping prompt-changing PRs)

```bash
LUCID_LIVE_LLM_SMOKE=1 docker compose exec -T backend \
    python -m pytest tests/smoke/test_claude_live.py -v
# EXPECTED: 2 passed. Cost: ~$0.02. Catches the 2026-06-22-style
# prompt-format regression (markdown fences, JSON-parse failure).
```

If this fails on `main` with no pending PR, it indicates that something
in the current `prompts.py` is returning a shape `safe_json_loads`
cannot handle — same incident class as 2026-06-22.

## Smoke 4 — agent verification pattern works end-to-end

Confirms the new agent pattern actually runs.

```bash
# From any agent worktree (e.g. .claude/worktrees/foo/):
cd .claude/worktrees/foo

docker compose run --rm \
    -v "$(pwd)/backend:/app" \
    -w /app \
    --no-deps \
    -e DATABASE_URL="postgresql://lucid:lucid@host.docker.internal:5432/lucid" \
    -e ELASTICSEARCH_URL="http://host.docker.internal:9200" \
    backend \
    python -m pytest -q tests/unit
# EXPECTED: green unit suite. The container vanishes after the run.
# The lucid-backend-1 container is unaffected — confirm with
# `docker compose ps backend` (uptime unchanged).
```

## What to do if any smoke fails

- Smoke 1 fails → override edit didn't land or compose didn't reload.
  `docker compose down && docker compose up -d --build backend` and retry.
- Smoke 2 fails → roll back this PR (`git revert <merge-commit>`),
  rebuild, file a bug.
- Smoke 3 fails (when there's no prompt PR pending) → check
  `backend/api/structure/claude_client.py::safe_json_loads`
  + `backend/api/structure/prompts.py` for a recent change.
- Smoke 4 fails on `docker compose run` → fall back to
  `docker run --rm` with the image tag (`docker compose images backend`
  to find it).
