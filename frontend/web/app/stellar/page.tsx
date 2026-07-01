/**
 * B-62 — /stellar route entry.
 *
 * Thin server-page wrapper that renders the client `StellarView`. The
 * actual UI lives in `components/StellarView.tsx` because three.js is a
 * client-only library. The AppShell from `app/layout.tsx` already wraps
 * every route, so this page only renders the fullscreen canvas surface.
 *
 * ★ REQ-014-C C0 (PO 2026-07-02) — 전체 화면 스크롤바 제거.
 *   증상: /stellar 진입 시 body 우측에 전체 화면 스크롤바.
 *   원인: AppShell footer (Lucid v{version}, ~40px) 가 100vh 아래로 밀리는데
 *        StellarView 가 calc(100vh - 64px) 를 차지하면서 총 shell 높이가
 *        100vh + footer 만큼 넘어 body overflow 발생.
 *   fix: (1) StellarView 컨테이너 높이 자체를 footer 만큼 더 뺀다
 *        (StellarView.tsx). (2) /stellar 라우트 마운트 동안 body overflow
 *        를 hidden 으로 잡아 다른 라우트 스크롤을 방해하지 않는다.
 */
import { StellarView } from '@/components/StellarView';
import { StellarScrollLock } from './scroll-lock';

export const dynamic = 'force-dynamic';

export const metadata = {
  // feat/i18n-ko-display-names-separation (★ PO 2026-06-30) — 한국어 표시명.
  // 내부 라우트 (/stellar) 와 컴포넌트명 (StellarView) 은 코드네임 유지.
  title: 'Lucid — 지식그래프',
  description: '검증된 사실을 한눈에 보는 3D 지식그래프.',
};

export default function StellarRoute() {
  return (
    <>
      <StellarScrollLock />
      <StellarView />
    </>
  );
}
