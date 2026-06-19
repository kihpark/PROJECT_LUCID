/**
 * B-59 — /home route entry.
 *
 * Thin server-page wrapper that renders the client `HomePage`. The actual
 * UI lives in `components/HomePage.tsx` because `useHomeBrief` is a
 * client hook (B-55/B-57 wiring). The AppShell from `app/layout.tsx`
 * already wraps every route, so this page only renders the body.
 *
 * Diagnosis: pre-B-59 the route table had no `/home` entry. The
 * AppShell nav (B-57) links to `/home` from "홈", so the broken nav
 * landed every fresh login on a 404. This file closes that gap.
 */
import { HomePage } from '@/components/HomePage';

export const dynamic = 'force-dynamic';

export default function HomeRoute() {
  return <HomePage />;
}
