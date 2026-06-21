import { redirect } from 'next/navigation';

// feat/landing-fix-spec: public beta-applicant landing moved off `/` and
// onto `/beta`. Root `/` is now the auth-aware app home (see app/page.tsx).
// The static landing markup itself stays at /landing-v82.html (in public/)
// untouched — this server component simply redirects there.
export default function BetaPage() {
  redirect('/landing-v82.html');
}
