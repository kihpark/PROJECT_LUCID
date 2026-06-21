/**
 * feat/landing-fix-spec — root `/` is auth-aware app home.
 *
 * Previously (landing-integration) `/` was a server-side redirect to
 * the public landing `/landing-v82.html`. The beta landing moved to
 * `/beta`, so `/` is reclaimed for the authed app shell:
 *  - authenticated user  -> /home
 *  - unauthenticated     -> /login
 *
 * Implementation note: auth state lives client-side via `useAuthMe`
 * (token in localStorage), so this MUST be a client component. We
 * render nothing during the auth-check flicker — the next.js router
 * replaces the URL as soon as `useAuthMe` resolves, so there's no
 * meaningful UI to draw here.
 */
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthMe } from '@/lib/useAuthMe';

export default function RootRedirect() {
  const router = useRouter();
  const { me, loading } = useAuthMe();

  useEffect(() => {
    if (loading) return;
    router.replace(me ? '/home' : '/login');
  }, [me, loading, router]);

  return null;
}
