# B-61 — Manual smoke recipe (browser)

Run after `docker compose up -d` and `cd frontend/web && corepack pnpm dev`.

1. **Register a new account**
   - Navigate to `/register`.
   - Enter a fresh email, a password ≥ 8 chars, and a display name.
   - Submit.
   - Expect: redirect to `/home`.
   - Expect: the personalised welcome line `환영합니다, <name>님. 첫 사실을 캡처하면 여기서 살아납니다.` is visible **above** the 3-step `여기서 시작합니다` card.

2. **Logout via AppShell profile menu**
   - Click the profile chip in the header.
   - Click `로그아웃`.
   - Expect: browser navigates to `/login`.
   - Expect: `localStorage.lucid_jwt` cleared; `lucid_space_id` cleared.
   - In DevTools Network, expect a `POST /api/auth/logout` (204).

3. **Login with the same credentials**
   - Navigate to `/login`.
   - Enter the email + password from step 1.
   - Submit.
   - Expect: redirect to `/pending` (existing behaviour from LoginForm).

4. **New user (no facts) sees cold-start welcome**
   - Open `/home` while logged in as the new user.
   - Expect: status label `LUCID · 첫 사실을 기다리는 중`.
   - Expect: welcome line visible.

5. **Old user (has captured facts) does NOT see welcome**
   - As an existing user with facts, open `/home`.
   - Expect: populated arm (orb + briefing card + stats), NOT the welcome line.

6. **Per-user isolation — two-user smoke**
   - As User A, capture a fact `SpaceX 본사는 LA에 있다`.
   - Logout.
   - Register User B (fresh email).
   - Login as User B → `/home`.
   - Expect: no SpaceX fact visible.
   - Navigate to `/recall`, search `SpaceX` → empty result, signature `검증된 사실이 없습니다`.
   - Attempt `GET /api/spaces/<A_space_id>` with User B's JWT (curl/devtools): expect HTTP 403.

7. **Login page → Register link**
   - Open `/login`.
   - Expect: `처음이신가요? 가입하기` link at the bottom → `/register`.

8. **Register page → Login link**
   - Open `/register`.
   - Expect: `이미 계정이 있으신가요? 로그인` link at the bottom → `/login`.
