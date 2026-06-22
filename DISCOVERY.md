# B-61-fix-admission — Discovery

## 1. Register assets present in main (to remove)

| asset | path | symbol / lines |
| --- | --- | --- |
| page | `frontend/web/app/register/page.tsx` | entire file (18 lines) |
| component | `frontend/web/components/RegisterForm.tsx` | entire file (152 lines) |
| test | `frontend/web/tests/RegisterForm.test.tsx` | entire file (161 lines) |
| FE link | `frontend/web/components/LoginForm.tsx` | lines 80-89 ("처음이신가요? 가입하기" Link href="/register") |
| FE api helper | `frontend/web/lib/api.ts` | RegisterRequest/RegisterResponse types + registerUser() (lines ~129-151) |
| backend route | `backend/api/routes/auth.py` | @router.post("/register") def register(...) (lines 58-113) |
| backend schemas | `backend/api/models/auth.py` | RegisterRequest (lines 11-14) + RegisterResponse (lines 34-39) |
| backend tests | `backend/tests/integration/test_b61_auth_flow.py` | refactored to direct ORM User+KS+UserSettings creation |
| backend tests | `backend/tests/integration/test_b61_isolation.py` | _register helper refactored to direct ORM creation |

## 2. users table — is_admin status
Absent in main. Migration 0017 adds it.

## 3. Alembic head
`0016_opl_v1_expansion` → new migration `0017_add_users_is_admin`, `down_revision = "0016_opl_v1_expansion"`.

## 4. lucid_applications mapping (read-only consumer view)
Doc id = `application_id`. Fields used: application_id, email, status, created_at, profession, q1, q2, lang.

## 5. Existing admin gate
None. Adding `require_admin` in `backend/api/security/dependencies.py`.
