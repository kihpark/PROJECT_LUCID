# B-61 Auth Onboarding — Discovery

Read-only audit of the auth + onboarding surface area before any edits land.

## Backend

### Auth routes (`backend/api/routes/auth.py`)

| Endpoint | Method | State | Notes |
|---|---|---|---|
| `/api/auth/register` | POST | EXISTS | Creates `User + KnowledgeSpace(personal) + UserSettings` in one tx. Returns `{user, space_id, access_token, token_type, expires_in}`. 409 on duplicate email. |
| `/api/auth/login` | POST | EXISTS | bcrypt verify, updates `last_login_at`, returns `{access_token, token_type, expires_in}`. 401 on bad creds. |
| `/api/auth/logout` | POST | EXISTS | JWT required (so callers can't logout others), 204, server-side stateless. |
| `/api/auth/me` | GET | **MISSING** | Gap closed by this ticket. |

### Security (`backend/api/security/`)

- `password.py`: bcrypt rounds=12 (already pinned in `backend/requirements.txt:26`).
- `jwt.py`: pyjwt HS256, stateless, `sub` claim is `User.id`.
- `dependencies.py`:
  - `OAuth2PasswordBearer(tokenUrl="/api/auth/login")`
  - `get_current_user(user_id) -> User` loads from Postgres via module-level sessionmaker (`_session_factory`). Tests rebind `sec_deps._session_factory` to the test DB.

### ORM (`backend/api/storage/postgres/orm.py`)

- `User`: `id (UUID, server_default gen_random_uuid())`, `email (unique, NOT NULL)`, `name (str | None — display field; there is NO separate `display_name`)`, `password_hash (str | None)`, `created_at (timezone-aware, NOT NULL server_default)`, `last_login_at (timezone-aware, nullable)`.
- `KnowledgeSpace`: `id (UUID)`, `user_id (FK → users.id ON DELETE CASCADE, NOT NULL)`, `type` CHECK in `('personal','team','policy','public')`, `name (nullable)`, `created_at`.
- No schema change needed for B-61 — every column the gap-fix wants already exists.

### Per-user isolation (read-only verification)

- **Routes** (`recall.py`, `home.py`, `validate.py`, `spaces.py`): every space-scoped route runs `_resolve_space(session, space_id, user)` (or inline checks for spaces.py), and returns **403** when `ks.user_id != user.id`.
  - `recall.py:83` — `_resolve_space`
  - `home.py:75`, `validate.py:71` — same helper
  - `spaces.py:62–66, 82–85` — inline `if ks.user_id != user.id: raise 403`
- **ES queries** (`storage/elasticsearch/facts.py`, `objects.py`, `queries.py`): every query carries `{"term": {"knowledge_space_id": ks_id}}` in the bool filter. Canonical-key dedup (`_find_fact_by_canonical_key`) is space-scoped.
- **Structure** (`structure/entity_resolver.py`): canonical entity lookup is per-space at lines 118 + 148 — same surface string in two spaces produces two distinct canonical entity UUIDs.
- **Verdict:** the isolation gap the ticket asked us to look for is **already closed**. The B-61 backend gap is only the missing `/me` shape.

### Migrations

- Head = `0016_opl_v1_expansion` (down_revision `0015_data_bedrock`).
- 0015 and 0016 are **NOT** touched by this ticket. No new migration.

### Test fixtures

- `backend/tests/integration/conftest.py` rewrites `DATABASE_URL` and `LUCID_INDEX_PREFIX` at import time to force `lucid_test` + `test_*` indexes, so the destructive downgrade test can never wipe the dev DB (B-30 lesson).
- `pg_session` rolls back per-test; `client` fixture rebinds `sec_deps._session_factory` AND each route's `_new_session` to the test engine, then commits.

## Frontend

### Auth surface (`frontend/web/`)

| Surface | State | Notes |
|---|---|---|
| `app/login/page.tsx` | EXISTS | Shell renders `<LoginForm/>` from `@/components/LoginForm`. |
| `components/LoginForm.tsx` | EXISTS | POSTs login → `setToken` → `getMySpaces` → `setCurrentSpace` → `router.push('/pending')`. **Missing register link.** |
| `app/register/page.tsx` | **MISSING** | Added by this ticket. |
| `components/RegisterForm.tsx` | **MISSING** | Added by this ticket. |
| `lib/api.ts` | partial | Exports `loginUser`. **Missing `registerUser`, `logoutUser`, `getMe`.** |
| `lib/auth.ts` | EXISTS | `setToken / getToken / clearToken / isAuthenticated / setCurrentSpace / getCurrentSpace / clearCurrentSpace`. JWT in localStorage `lucid_jwt` + `SameSite=Lax` cookie mirror. |
| `lib/useAuthMe.ts` | **MISSING** | Added by this ticket. |

### AppShell (`components/AppShell.tsx`)

- `defaultUserName()` line 51–55: literal `'박기흥'` — used until login wiring lands.
- `defaultUserEmail()` line 57–59: literal `'kihung@lucid.kr'` — **this is the email literal the ticket flags. Fixing to `kihpark85@lucid.kr`.**
- `logout()` line 61–68: client-only. Calls `clearToken() + clearCurrentSpace() + window.location.href='/login'`. **Does NOT call the backend `/api/auth/logout` endpoint.** Fixed by this ticket so the server logs the logout (and any future denylist gets the JTI).
- `data-testid="app-shell-logout"` button at lines 273–295 — preserved.
- `app/layout.tsx` mounts `<AppShell>{children}</AppShell>` and does not pass userName/userEmail props.

### HomePage (`components/HomePage.tsx`)

- Two-state surface (`empty | populated | unknown`). Cold-start arm (`HomeColdStart` at line 939) currently renders: `ColdEmptyLine`, `ColdCTA`, `DisabledRecallInput`, `GettingStartedCard` (3-step guide).
- `HomePage({ userName = '박기흥' })` line 1024 — the default literal again.
- **No personalised welcome line.** B-61 adds one above the 3-step card when `is_new_user=true` and `display_name` is known.

### Tests (`frontend/web/tests/`)

- `AppShell.test.tsx`: structural + nav + profile menu + 검증 badge. Does NOT assert email literal. Logout button never clicked in existing suite, so changing the logout handler does not break it; new tests added for the new behaviour.
- `HomePage.test.tsx`: full populated/empty/fail-soft coverage. Mocks `useHomeBrief`. New test added for the welcome line.
- No `LoginForm`/`RegisterForm` tests.

## Extension

- Popup is fail-soft on logged-out (`renderLoggedOut`). **No changes for B-61.** Extension vitest stays at 51.

## Summary table

| Area | Gap | Action |
|---|---|---|
| Backend `/api/auth/me` | missing | add route + response model |
| Backend cold-start signal | n/a | computed inline (`is_new_user`) |
| Backend ES count helper | missing helper | add `count_active_facts` in `storage/elasticsearch/facts.py` |
| Backend isolation | none | verified — no change |
| Frontend `registerUser` | missing | add to `lib/api.ts` |
| Frontend `logoutUser` | missing | add to `lib/api.ts` |
| Frontend `getMe` | missing | add to `lib/api.ts` |
| Frontend `useAuthMe` | missing | new hook |
| Frontend `/register` | missing | new page + form |
| Frontend `/login` register link | missing | edit `LoginForm.tsx` |
| Frontend AppShell logout → backend | client-only | wire `logoutUser()` |
| Frontend AppShell email default | `kihung@lucid.kr` | `kihpark85@lucid.kr` |
| Frontend AppShell identity | hardcoded | prefer `useAuthMe().me` |
| Frontend HomePage welcome | none | add `WelcomeLine` for `is_new_user` |

## Risk

- `count_active_facts` is best-effort. Wrapping in `try/except` and returning 0 keeps `/me` resilient when ES is down — `is_new_user` falls back to "true within 7 days, no facts" which is the safe cold-start default.
- AppShell logout change is async — the existing test does NOT click the logout button, so it's not affected. The new test asserts the new behaviour.
- `useAuthMe` runs once on mount inside AppShell — if there is no token, it short-circuits to `{me: null}` and the existing default literal stays in place. No new fetch on the login page.
- JWT is stateless, so the `/api/auth/me` endpoint cannot be invalidated by logout. The dedicated test documents this with a docstring rather than pretending a denylist exists.

## Decisions

1. **No new migration.** The User table has every column we need.
2. **`is_new_user` is computed at `/me` request time**, not stored. Created_at + ES count is enough. (Two cheap reads beat an extra column we'd have to keep in sync.)
3. **Welcome line copy is verbatim**: `환영합니다, {name}님. 첫 사실을 캡처하면 여기서 살아납니다.`
4. **AppShell logout is best-effort to the backend** — failures are swallowed so the user is never stuck in a "stuck logged-in" UI state when the server is unreachable.
5. **Display name fallback** in AppShell: `me.display_name ?? me.email.split('@')[0]` when authenticated. When `me` is `null` (no token, or while loading), the existing `defaultUserName()` literal still shows.
