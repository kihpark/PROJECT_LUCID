# syntax=docker/dockerfile:1.6
# Single-stage build (chore/lucid-web-docker-fix, option 2).
# The multi-stage variant from PR-4A-1 broke on Windows hosts where
# pnpm's symlink-based node_modules carries over via `COPY . .` and
# overlays the cleanly-installed Linux node_modules. Single-stage
# + .dockerignore eliminates the failure mode.
FROM node:24-bookworm-slim AS web

WORKDIR /app

# Enable corepack so pnpm is on PATH (Node 24 ships it).
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy only the manifest first so the install layer is cacheable across
# unrelated source-file edits.
COPY package.json ./
COPY pnpm-lock.yaml* ./

# `--frozen-lockfile` is intentional: PO regenerates pnpm-lock.yaml
# locally and commits it. CI / Docker uses the locked versions.
# If no lockfile exists yet (first build) pnpm falls back gracefully.
RUN pnpm install --frozen-lockfile || pnpm install

# Now copy the rest. .dockerignore keeps node_modules / .next / .git
# out of the build context.
COPY . .

# Production Next.js build. With output: 'standalone', this produces
# .next/standalone/server.js + minimal node_modules already in /app.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 3000

# Run the standalone server directly. `node server.js` would require us
# to flatten the .next/standalone layout; `pnpm start` instead reads
# package.json and works in-place.
CMD ["pnpm", "start"]
