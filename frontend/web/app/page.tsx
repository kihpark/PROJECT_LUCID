import { redirect } from 'next/navigation';

// B-62 landing-integration: the root path serves the beta-applicant
// landing page. Authenticated routing (logged-in users -> /home) is
// reconciled by B-61 in a separate PR.
export default function RootPage() {
  redirect('/landing-v82.html');
}
