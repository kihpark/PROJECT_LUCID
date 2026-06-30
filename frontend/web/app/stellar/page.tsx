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
  // feat/i18n-ko-display-names-separation (★ PO 2026-06-30) — 한국어 표시명.
  // 내부 라우트 (/stellar) 와 컴포넌트명 (StellarView) 은 코드네임 유지.
  title: 'Lucid — 지식그래프',
  description: '검증된 사실을 한눈에 보는 3D 지식그래프.',
};

export default function StellarRoute() {
  return <StellarView />;
}
