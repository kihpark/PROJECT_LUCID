# Infra Agent Isolation — Discovery

## Incident summary (2026-06-22)

1. Agent (`feat/spo-subject-language-by-type`) edited files inside its own worktree.
2. As part of verification it copied modified `backend/**/*.py` files into the
   SHARED repo's `backend/` directory so `docker compose exec backend pytest`
   could observe them.
3. The SHARED `backend/` directory was **bind-mounted** into the running
   `lucid-backend-1` container (`./backend:/app` in
   `docker-compose.override.yml`).
4. The container ran `uvicorn api.main:app ... --reload`, which uses
   `watchfiles` to detect filesystem changes and hot-restart the process.
5. PO captured an article live. The freshly-mounted code path included a
   broken prompt format change → LLM returned content wrapped in
   ` ```json ` markdown fences → `safe_json_loads` failed → 0 facts.

**Root cause.** The dev-inner-loop convenience (bind-mount + `--reload`)
opened an attack surface where ANY edit to the SHARED `backend/` tree
immediately became the running service. The agent's verification step
was indistinguishable from PO's own edits, from the container's POV.

---

## 0.1 Pre-change docker compose config

### `docker-compose.yml` (base, lines 49–62)

```yaml
backend:
  build: ./backend
  ports:
    - "8000:8000"
  env_file:
    - .env
  environment:
    DATABASE_URL: "postgresql://${POSTGRES_USER:-lucid}:${POSTGRES_PASSWORD:-lucid}@postgres:5432/${POSTGRES_DB:-lucid}"
    ELASTICSEARCH_URL: "http://elasticsearch:9200"
  depends_on:
    postgres:
      condition: service_healthy
    elasticsearch:
      condition: service_healthy
```

Base file already documented the production shape (no bind mount, no
`--reload`). The base service relies on the image's `CMD`
(`backend/Dockerfile` line 22 — plain uvicorn, no `--reload`).

### `docker-compose.override.yml` (dev override, lines 21–28)

```yaml
backend:
  # The image is the same one base compose built; we only swap in
  # the source bind mount and the --reload command so editing a .py
  # file restarts uvicorn in-process. `uvicorn[standard]` is already
  # in requirements.txt so watchfiles is available.
  volumes:
    - ./backend:/app
  command: uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

These two lines are the entire attack surface.

### `backend/Dockerfile` (lines 1–22)

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
ENV FASTER_WHISPER_DOWNLOAD_DIR=/models
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', download_root='/models', device='cpu')"
COPY . .                # <-- backend code IS baked into the image
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`COPY . .` is on line 19 — the image already carries a self-contained copy
of the backend tree. No Dockerfile change is required for this PR; we
only need to stop *overlaying* the host tree on top of it.

---

## 0.2 Agent verification pattern (before this PR)

Implicit / not documented anywhere except by convention. The pattern was:

```bash
# from worktree
cp <worktree>/backend/<edited>.py <SHARED>/backend/<edited>.py
docker compose exec -T backend python -m pytest -q
```

The shared copy then bled into the running container via the bind mount.

## 0.2 Agent verification pattern (after this PR)

Ephemeral container — image + worktree mount, container removed after run.
The SHARED `backend/` is never touched.

```bash
# from worktree root (the dir containing pyproject.toml, backend/, etc.)
docker compose run --rm \
  -v "$(pwd)/backend:/app" \
  -w /app \
  --no-deps \
  -e DATABASE_URL="postgresql://lucid:lucid@host.docker.internal:5432/lucid" \
  -e ELASTICSEARCH_URL="http://host.docker.internal:9200" \
  backend \
  python -m pytest -q
```

Key properties:

- `--rm` — container disposed after the pytest run.
- `-v "$(pwd)/backend:/app"` — mounts the AGENT'S worktree backend, not
  the SHARED one. The running `lucid-backend-1` container is unaffected.
- `--no-deps` — postgres / elasticsearch already running from
  `docker compose up -d`; we reuse them (shared state, since pytest
  fixtures clean up after themselves).
- `host.docker.internal` reaches the host network where postgres / es
  ports are mapped (5432 / 9200). Inside the docker-compose network, the
  service names `postgres` and `elasticsearch` resolve too — but the
  ephemeral container is started outside the compose network when
  `--no-deps` skips dependency resolution, so we use the host port map.
  Alternative: pass `--network lucid_default` (compose project name) and
  use `postgres:5432` directly.

---

## 0.3 Existing pytest infrastructure

- `backend/pytest.ini` — `pythonpath=.`, `asyncio_mode=auto`, `testpaths=tests`.
  Independent of any host path.
- `backend/conftest.py` — **does not exist** at the backend root. Fixtures
  live inside `tests/`.
- `docker compose exec -T backend python -m pytest -q` inside the
  container only uses container-internal paths (`/app/...`) — no host
  resources required.

---

## PO post-merge workflow

Code change cycle, after this PR ships:

```bash
# 1. Edit a backend file on the host.
# 2. Rebuild + recreate the backend service.
docker compose up -d --build backend
# (or, equivalently, the explicit two-step:
#   docker compose build backend
#   docker compose restart backend
#  — but `up -d --build` is shorter and handles "container missing".)
```

**Cost.** ~10–20s rebuild per code change (mostly cached layers — only
the `COPY . .` layer + any layer above it that touched changes).

**Hot reload is gone.** This is the deliberate trade-off — the only
filesystem path into the running container is now the image, and the
only way to update the image is `docker compose build`. Agents writing
to the host can no longer reach the live backend.

---

## How to run the live Claude smoke (§1.5)

The new live test is gated by `LUCID_LIVE_LLM_SMOKE=1` and skipped by
default (CI + agents must not pay LLM cost on every run).

```bash
LUCID_LIVE_LLM_SMOKE=1 docker compose exec -T backend \
    python -m pytest tests/smoke/test_claude_live.py -v
```

When to run:

- Before shipping ANY prompt-changing PR (`backend/api/structure/prompts.py`
  or anywhere `decompose()` is touched).
- In a scheduled CI job — not on every PR (cost).

Cost: ~2 Claude calls per run, ~$0.01 each — total < $0.05.

What it catches: prompt-format regressions that mocked tests can't see.
The specific 2026-06-22 incident (markdown fences in the LLM response
that `safe_json_loads` couldn't strip) is exactly this category.

---

## Manual smoke — host edit invisible to container

Verifies post-merge that a host-side edit no longer reaches the running
container.

```bash
# 1. Edit a backend file on the host (no rebuild).
echo "# infra-isolation marker" >> backend/api/main.py
# 2. Inspect the container's view.
docker compose exec backend grep "infra-isolation marker" /app/api/main.py
# Expected: no match. The container's /app/api/main.py is the image's
# copy, unchanged.
# 3. Revert.
git checkout backend/api/main.py
```

Full procedure also documented in `INFRA_ISOLATION_MANUAL_SMOKE.md`.

---

## Decisions

- The override file is kept (not deleted). The `web` service still wants
  HMR + bind-mount — that's the frontend dev loop and is in scope only
  for the web container, not the backend. Removing only the backend
  block leaves the file useful.
- `backend/Dockerfile` is unchanged. `COPY . .` (line 19) already bakes
  the backend tree into the image; the only fix needed is removing the
  override that overlays the host tree on top.
- `lucid-ship` is unchanged. It runs `docker compose exec -T backend
  python -m pytest -q` against the running container. Post-merge that
  container reflects the IMAGE — so before `lucid-ship` is invoked, the
  PO is expected to have already run `docker compose up -d --build
  backend` (the new daily workflow). If we baked a `--build` into
  `lucid-ship`, every merge would pay the 10–20s rebuild cost even when
  the diff didn't touch backend; that's the wrong default. Documented in
  the report instead.
