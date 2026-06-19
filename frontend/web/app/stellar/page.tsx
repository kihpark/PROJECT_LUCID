/**
 * B-62 — /stellar route entry.
 *
 * Thin server-page wrapper that renders the client `StellarView`. The
 * actual UI lives in `components/StellarView.tsx` because three.js is a
 * client-only library. The AppShell from `app/layout.tsx` already wraps
 * every route, so this page only renders the fullscreen canvas surface.
 */
import { StellarView } from '@/components/StellarView';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Lucid — Stellar View',
  description: 'A 3D galaxy of your validated facts.',
};

export default function StellarRoute() {
  return <StellarView />;
}
