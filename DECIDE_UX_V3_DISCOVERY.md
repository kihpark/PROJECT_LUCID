# feat/decide-ux-v3 — discovery

Baseline = `910fe91` (main).

PO directive: remove negation badge (UI only, preserve data); diagnose + fix autocomplete
LIVE path where chips don't appear despite passing unit tests.

## 0.1 Negation badge — current state

`frontend/web/components/FactCard.tsx` lines **336-346**:

```jsx
{fact.negation_flag && (
  <span
    className="inline-flex items-center gap-1 text-xxs text-accent-error"
    aria-label="부정 진술"
    role="status"
    title="이 사실은 '~할 수 없다 / 금지 / ~지 않다' 를 담은 부정 진술입니다."
    data-testid={`fact-negation-${factUid}`}
  >
    ⚠ 부정 진술
  </span>
)}
```

- The badge reads `fact.negation_flag` (boolean) — pure UI render gate.
- `negation_scope` is NOT consumed here (it's persisted but the badge ignores it).
- No other frontend component renders the negation badge:
  - `grep -r "negation_flag" frontend/web` → matches in `FactCard.tsx`, tests, and `lib/types.ts` (type definition).
  - No imports of negation badge JSX elsewhere.
- Backend `negation_flag` / `negation_scope` extraction lives in `backend/spo/` and ES mapping — **not touched** by this PR.

## 0.2 Autocomplete LIVE diagnosis — 5-step trace

### Step 1 — onChange bound?

`FactCard.tsx` line **398-414** (subject input):

```jsx
<input
  id={`edit-subject-${factUid}`}
  data-testid={`fact-edit-subject-${factUid}`}
  type="text"
  value={subjectQuery}
  onChange={(e) => {
    const val = e.target.value;
    setSubjectQuery(val);
    emitEdit({ subject: val });
  }}
  ...
/>
```

- onChange IS bound. It calls `setSubjectQuery(val)` AND `emitEdit({ subject: val })`.
- `setSubjectQuery(val)` updates local state → `subjectQuery` → fed to `useDebounce` →
  `debouncedSubjectQuery`.
- **Verdict**: handler is wired in code. Live: needs instrumentation to confirm keystrokes fire it.

### Step 2 — Debounce firing?

`FactCard.tsx` line **82-89**:

```js
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
```

- Standard hook. `useState(value)` initializer runs once with the initial value.
- Each new `value` schedules a `setTimeout`; previous timer cleared on cleanup.
- After `delay` ms (200ms here, line 142), `setDebounced(value)` fires → next render with
  new `debouncedSubjectQuery`.
- **Verdict**: looks correct. Could fail in live if React 18 strict-mode causes the effect
  to fire twice (the timer would still settle eventually). Needs instrumentation.

### Step 3 — spaceId in edit mode?

- `DecideOverlay.tsx` line **331**: passes `spaceId={spaceId}` to each `FactCard`.
- `DecideOverlay` receives `spaceId` from `app/pending/[jobId]/page.tsx` line ~22:
  `const spaceId = spaceMatch ? decodeURIComponent(spaceMatch[1]!) : '';`
- The page returns the "Sign in" early-return if `!token || !spaceId`. So if `DecideOverlay`
  renders, `spaceId` MUST be a non-empty string from the cookie.
- **Verdict**: `spaceId` IS propagated. But the fetch effect gate `if (... || !spaceId)`
  would short-circuit if it's somehow empty string `''` (which is falsy). Confirmed safe.

### Step 4 — API URL?

`frontend/web/lib/api.ts` line **377-388**:

```js
export function searchEntitySuggestions(
  q: string,
  spaceId: string,
  limit = 5,
): Promise<EntitySuggestion[]> {
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('limit', String(limit));
  return request<{ items: EntitySuggestion[] }>(
    `/api/spaces/${spaceId}/entities/suggest?${params.toString()}`,
  ).then((r) => r.items);
}
```

Constructed URL example: `/api/spaces/<uuid>/entities/suggest?q=ACME&limit=5`.

Backend route (`backend/api/routes/entities.py` line 25, 54):
- `router = APIRouter(prefix="/api/spaces/{space_id}", tags=["entities"])`
- `@router.get("/entities/suggest", response_model=EntitySuggestionsResponse)`

URL matches. `_resolve_space` validates `space_id` is a real UUID — if the cookie's space
slug is NOT a valid UUID (e.g., a placeholder string), this returns 404 and `request()`
throws → `.catch` in FactCard sets suggestions to `[]`. **Verdict**: URL construction
correct; live failure mode would manifest as caught exception → empty chips.

### Step 5 — Render gate condition?

`FactCard.tsx` line **415-429**:

```jsx
{subjectSuggestions.length > 0 && (
  <div className="mt-1 flex flex-wrap gap-1">
    {subjectSuggestions.map((s) => (
      <button
        key={s.entity_id}
        type="button"
        onClick={() => onSubjectChipClick(s)}
        data-testid={`subject-chip-${s.entity_id}`}
        className="text-xxs rounded border border-accent-cool/40 ..."
      >
        → {s.primary_label} [{s.primary_lang}]
      </button>
    ))}
  </div>
)}
```

- Gate: `subjectSuggestions.length > 0`. Single condition.
- If the API returns `{items: []}` (empty), no chips render — silently empty.
- **Verdict**: render gate is permissive. If chips never appear in live, the most likely
  reason is `subjectSuggestions` stays `[]` because either (a) the API isn't reached, (b)
  it's reached but returns empty, or (c) the response shape is unexpected (e.g., backend
  sends `[]` directly instead of `{items: []}`) — though the response_model on the backend
  guarantees `EntitySuggestionsResponse` shape, so (c) is unlikely.

## 0.3 IDENTIFIED candidate bugs (ranked by likelihood)

Without running the live backend in this environment, the **top three** candidates:

1. **(highest)** `subjectQuery` initial state is the resolved label (e.g., `"Seoul FX Market
   Operations Council"`). On Edit-open, the immediate fetch query is this full label. ES
   `match_phrase_prefix` on this exact label returns the entity itself (if any) — but the
   chip shown is `→ Seoul FX Market Operations Council [ko]` which IS the current selection
   and looks redundant. PO might be perceiving "no useful suggestions" because the only
   chip duplicates the input. **Fix**: gate the fetch to only fire when the query DIFFERS
   from the resolved label of the current selected uid — i.e., only show chips when the
   user has actually started editing.

2. **(medium)** The Korean entity ES index doesn't have entries matching what PO is typing,
   so the API returns `{items: []}` and chips never appear. **Fix**: this is a data issue,
   not code — but instrumentation will reveal it.

3. **(low)** A subtle React 18 strict-mode double-render issue causing the debounce timer
   to keep getting reset before it fires. **Fix**: instrumentation will reveal it; can
   raise the debounce to be safe or move the debounce inside the effect.

## 0.4 BroadcastChannel availability (for PR-3, NOT this PR)

- BroadcastChannel API is available on localhost in modern browsers (Chrome, Firefox, Edge).
- Frontend dev server runs on `localhost:3000` per `package.json` ("dev": "next dev -p 3000").
- Pattern is viable for cross-tab event broadcasting in PR-3.

## Approach for this PR

1. **Delete negation badge JSX** (lines 336-346). Keep `fact.negation_flag` field read
   intact (it remains in the type). No imports become unused (no negation-specific imports).

2. **Add `console.debug` instrumentation** at all 5 trace points, gated by
   `process.env.NODE_ENV === 'development'`. PO opens DevTools verbose console, types in
   subject input, watches the trace to see which step breaks. Logs stay in code for future
   diagnosis.

3. **Apply the most-likely fix** for the highest-probability bug (#1 above): on Edit-open,
   DON'T immediately fetch suggestions if `subjectQuery === resolved label of current
   subject_uid` AND the user hasn't typed. Use a "user has typed" flag.

4. **Tests**:
   - Update existing 3 negation badge assertions in `tests/FactCard.test.tsx` (lines
     69-84, 796-841) to assert badge ABSENCE.
   - Add live-path autocomplete test: render FactCard with spaceId, fire change event on
     subject input, wait for debounce, assert API was called, assert chips render.
     (Existing test already covers this; verify it still passes with the fix.)
