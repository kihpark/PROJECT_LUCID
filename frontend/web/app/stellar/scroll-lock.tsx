/**
 * ★ REQ-014-C C0 (PO 2026-07-02) — /stellar 라우트 전용 body scroll lock.
 *
 * 배경:
 *   /stellar 는 AppShell (header 64px sticky + main + footer ~40px) 안에
 *   fullscreen 캔버스 (StellarView) 를 그린다. StellarView 의 outer div
 *   는 height calc(100vh - 64px - 40px) 로 header/footer 두 영역 모두를
 *   제외하지만, three.js 캔버스 초기화 타이밍이나 브라우저별 계산 오차로
 *   1~2px overflow 가 발생해도 body 우측에 전체 화면 스크롤바가 생긴다.
 *
 * 접근:
 *   /stellar 가 마운트된 동안만 document.body.style.overflow = 'hidden'
 *   으로 강제하고 unmount 시 원복. 다른 라우트는 영향 없음.
 *   html 도 함께 hidden 으로 잡아 iOS Safari / Windows 크로미움에서 body
 *   레벨만 잠글 때 html 이 스크롤바를 재생성하는 케이스를 원천 봉쇄.
 *
 * 왜 useEffect 인가:
 *   서버 렌더링에서는 document 가 없어 SSR 시 아무 것도 하지 않고,
 *   클라이언트 마운트 후에만 style 을 만진다. cleanup 은 라우트 이동
 *   또는 새로고침 unmount 에서 반드시 원복돼야 다른 페이지 스크롤이
 *   막히지 않는다.
 */
'use client';

import { useEffect } from 'react';

export function StellarScrollLock(): null {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, []);
  return null;
}

export default StellarScrollLock;
