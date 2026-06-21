# feat/landing-fix-spec - Step 0 Discovery

## app/page.tsx (current)
- 9-line Server Component: `export default function RootPage() { redirect('/landing-v82.html'); }`
- This is exactly what landing-integration shipped. Overrides B-61's intended root (B-61 never landed an app/page.tsx of its own - its home route is /home, not /).
- AFTER fix: replace with a CLIENT component (`'use client'`) that uses `useAuthMe()` and `router.replace('/home' | '/login')`. B-61 owns /login and /home.

## landing-v82.html - form inputs (REAL name= attributes)
Form lives in `<section id="apply">` at lines 373-437. The four inputs are:
1. **email**: `<input type="email" placeholder="your@email.com" required>` - NO `name=` attr, NO `id=` attr. Script identifies it via `formWrap.querySelector('input[type=email]')`.
2. **profession**: `<input type="text" id="prof-input" ... required>` - has `id="prof-input"`, no `name=`.
3. **q1**: `<textarea id="q1-input" ... required></textarea>` - has `id="q1-input"`, no `name=`.
4. **q2**: `<textarea id="q2-input" ... required></textarea>` - has `id="q2-input"`, no `name=`.

PO assumption confirmed: profession DOES exist. The HTML form has exactly the four PO-spec fields. No HTML structural change needed - the script just changes the JSON body shape.

## landing-v82.html - inline script (current)
Appended block (lines 443-592). Posts the 6-field shape: email, display_name=prof, lang, survey_q1_key='verification_method_friction', survey_q1_value=q1, survey_q2_key='blurry_fact_recall_experience', survey_q2_value=q2.
Becomes flat 4-field: email, profession=prof, q1, q2, lang.
Everything else (success/error inline UI, lang detection, button-disable) stays.

## backend/api/routes/applications.py - dup policy
- Current: submit_application() does dup-check via term: email_lower; on hit returns ApplicationResponse(..., duplicate=True) and EXITS.
- AFTER fix: drop the early-return on hit; reuse the existing application_id on hit and re-write the doc (upsert). Set source='landing-v82', status='pending', created_at=now() server-side. Drop display_name + survey_*; add profession, q1, q2. Drop duplicate from response.

## backend/api/models/applications.py
- Current ApplicationRequest: email, display_name|None, lang|None ('ko'|'en'), survey_q1_key, survey_q1_value, survey_q2_key, survey_q2_value.
- Current ApplicationResponse: application_id, status, duplicate=False.
- AFTER fix: replace with email, profession, q1, q2, lang. Response drops duplicate.

## backend/api/storage/elasticsearch/mappings.py
- Current LUCID_APPLICATIONS_MAPPING has display_name, survey_q1_key, survey_q1_value, survey_q2_key, survey_q2_value, status, submitted_at, etc.
- AFTER fix: drop survey_* and display_name. Add profession(text), q1(text), q2(text), source(keyword). Keep status(keyword). RENAME submitted_at -> created_at(date). Keep application_id, email, email_lower, lang, submitter_ip_hash, user_agent.

## backend/tests
- backend/tests/integration/test_applications_endpoint.py: 8 cases - _payload() uses 6-field shape, test_duplicate_email_returns_existing_application_id checks duplicate=True. Rewritten in full to 4-field + upsert + server-meta cases.
- backend/tests/unit/test_applications_dup_guard.py: 3 pure email-normalisation cases. Kept + added an upsert-id case + no-hits case.
- backend/tests/unit/test_es_mappings.py asserts suffix set {facts, objects, sources, applications} - UNCHANGED, the index name itself doesn't change.

## B-61 authed home
- B-61 shipped app/login/page.tsx, app/home/page.tsx, app/register/page.tsx (register being removed by a separate PR - not our concern).
- B-61 did NOT ship an app/page.tsx of its own. landing-integration's redirect IS the / route. After we replace it with RootRedirect, the auth-aware logic lives there: me ? '/home' : '/login'.
- useAuthMe() shape is { me: MeResponse|null, loading: boolean, error: Error|null } - matches the spec template.

## Index recreation strategy (chosen: a)
- We extend create_indexes() in indexes.py so that for LUCID_APPLICATIONS specifically, if the live mapping is missing 'q1' (or has the legacy 'display_name'), the index is DELETED + recreated. Destructive on dev. No production data exists yet for lucid_applications.
- Other indexes (facts/objects/sources) are unaffected - purely an applications-only check.
