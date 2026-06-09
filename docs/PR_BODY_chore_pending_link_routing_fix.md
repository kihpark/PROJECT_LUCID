# chore/lucid-pending-link-routing-fix — Pending card href uses dynamic segment

Off `main`. Walking-Skeleton Iteration 2 Bug 1. Tiny critical-path fix.

## Diagnosis

PR-4A-2's `PendingCard` used object-form href:

```tsx
<Link href={{ pathname: '/pending/[jobId]', query: { jobId: job.job_id } }}>
```

Next.js **does not** substitute the dynamic `[jobId]` segment in object-form hrefs. It concatenates pathname + query string literally, so every click landed on `/pending/[jobId]?jobId=<UUID>` — a route the file system doesn't have, so the user got NotFound. That broke the entire critical path between the Pending Queue and the Decide Overlay — the whole Validate flow was unreachable in the browser.

## Fix

Three Link sites get the same template-literal normalisation:

| File | Before | After |
|------|--------|-------|
| `components/PendingQueueList.tsx` | `href={{ pathname: '/pending/[jobId]', query: ... }}` | ``href={`/pending/${job.job_id}` as Route}`` |
| `components/PendingQueueView.tsx` | `href={{ pathname: '/pending/auto-accepted' } as never}` | `href={'/pending/auto-accepted' as Route}` |
| `app/pending/auto-accepted/page.tsx` | `href={{ pathname: '/pending' } as never}` | `href={'/pending' as Route}` |

All three use `as Route` so the experimental TypedRoutes layer still typechecks — Route is the generated union of all valid in-app paths.

## Regression test

`tests/PendingQueueList.test.tsx` gets one new case:

```ts
it('card href is the resolved dynamic segment, not a literal [jobId]', () => {
  render(<PendingQueueList page={page} onPage={() => {}} />);
  const link = screen.getByTestId('pending-card-job-1').closest('a');
  expect(link!.getAttribute('href')).toBe('/pending/job-1');
  expect(link!.getAttribute('href')).not.toContain('[jobId]');
  expect(link!.getAttribute('href')).not.toContain('?jobId=');
});
```

The original PR-4A-2 test suite asserted the card existed but never inspected its href — that's how this bug slipped through 8 Vitest cases.

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` (backend) | All checks passed |
| `mypy .` (backend) | Success — no issues in 90 source files |
| `pytest tests/unit -q` (backend) | **215 passed** — backend untouched |
| `pnpm test` (PO) | 21 cases pass (20 PR-4A-2 + 1 regression) |

## Commit

```
6f9c46f  chore(web): fix Pending card href — use template literal not object form
```

## What this PR does NOT do

- Does NOT fix the SSR ECONNREFUSED — that's `chore/lucid-api-url-server-client-split` (Walking-Skeleton Bug 2)
- Does NOT migrate other components to TypedRoutes object form — the template literal is the canonical pattern
- Does NOT add visual regression — the test is a unit check on the rendered href

## Test plan

- [ ] `cd frontend/web && pnpm test` → 21 cases pass
- [ ] PO manual: visit `/pending` → click any card → URL becomes `/pending/<UUID>`, Decide Overlay starts loading (will still ECONNREFUSED until chore 4 lands)
- [ ] Confirm the regression test fails on the old code: re-apply the object-form href locally and `pnpm test` should report the new case red
