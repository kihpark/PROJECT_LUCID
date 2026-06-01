# syntax=docker/dockerfile:1.6
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --frozen-lockfile=false

FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public 2>/dev/null || true
EXPOSE 3000
CMD ["node", "server.js"]
