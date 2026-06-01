# Lucid Web (frontend)

Sprint 4A PR-4A-1 — Decide Overlay UI.

Stack: Next.js 15 (App Router) + TypeScript strict + Tailwind + IBM Plex.
Auth: JWT via `lucid_jwt` cookie mirror (set by `lib/auth.setToken`).

## Quick start

```sh
pnpm install
pnpm dev
```

Visit `http://localhost:3000/pending/<job_id>` once you have a JWT token
stored (auth UI lands in PR-4A-2). For ad-hoc testing, set the cookie by
hand:

```js
document.cookie = `lucid_jwt=${TOKEN}; path=/`;
document.cookie = `lucid_space_id=${SPACE_UUID}; path=/`;
```

The API base URL defaults to `NEXT_PUBLIC_API_URL` (compose sets it to
`http://backend:8000`).
