/**
 * AppShell — the fixed application chrome (header + primary nav) that wraps
 * every page in the App Router. Pure layout: no data fetching except the
 * lightweight pending-count badge via useHomeBrief, no redirects, no auth
 * decisions. Style tokens come from the design handoff (lucid-design README).
 *
 * Design tokens (from README):
 *   bg          #06080b
 *   accent      #3fe0c6
 *   header bot  #121a1d
 *   text 1°     #eaf1f2  body #cdd9da  secondary #9db0b5  dim #647479 / #56686d
 *   header h    64px  pad 0 30px
 *   profile button: 30px circle + name + chevron
 *   dropdown:   230px wide, top:50px right:0, bg #0c1316, border #1c272b, radius 13
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clearToken, clearCurrentSpace } from '@/lib/auth';
import { logoutUser } from '@/lib/api';
import { useAuthMe } from '@/lib/useAuthMe';
import { useHomeBrief } from '@/lib/useHomeBrief';
import { sectionLabelKo } from '@/lib/displayNames';
import { LUCID_VERSION } from '@/lib/version';

const ACCENT = '#3fe0c6';
const BG = '#06080b';
const HEADER_BORDER = '#121a1d';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_BODY = '#cdd9da';
const TEXT_SECONDARY = '#9db0b5';
const TEXT_DIM = '#647479';
const TEXT_DIMMER = '#56686d';
const MENU_BG = '#0c1316';
const MENU_BORDER = '#1c272b';
const LOGOUT_RED = '#c98b86';

interface NavItem {
  href: string;
  label: string;
  /** When set, displayed inline as a count badge (e.g. 검증(N)). */
  count?: number;
}

interface AppShellProps {
  children: React.ReactNode;
  /** Optional override for the displayed user name (mainly for tests). */
  userName?: string;
  /** Optional override for the user email shown in the dropdown header. */
  userEmail?: string;
}

function defaultUserName(): string {
  // Until login wiring is done, default to the design-mock identity.
  // B-61 prefers useAuthMe().me when present; this fallback only fires
  // for logged-out pages or while the /me fetch is in flight.
  return '박기흥';
}

function defaultUserEmail(): string {
  // B-61 — switched literal from kihung@lucid.kr to PO's preferred
  // address so the design mock matches the registered identity.
  return 'kihpark85@lucid.kr';
}

async function logout(): Promise<void> {
  // B-61 — best-effort call to the backend so the server logs the
  // event (and any future denylist gets the JTI). Network failures
  // are swallowed inside logoutUser() so we always proceed to
  // clearing local state.
  await logoutUser();
  clearToken();
  clearCurrentSpace();
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

/** Inline diamond mark — the wordmark accent next to "Lucid". */
function LogoMark() {
  return (
    <svg
      data-testid="app-shell-logo-mark"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <g transform="rotate(45 12 12)">
        <rect
          x={4}
          y={4}
          width={16}
          height={16}
          rx={2}
          ry={2}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1.6}
        />
      </g>
      <circle cx={12} cy={12} r={2.6} fill={ACCENT} />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path
        d="M1.5 3.5L5 7L8.5 3.5"
        stroke="#6b7d82"
        strokeWidth={1.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** REQ-009 (★ PO 2026-06-30) — 언어 설정 entry point.
 *
 * PO 의뢰서 verbatim:
 *   • 한/영 진입점이 ★ 화면에 없음 → REQ-002 displayNames 맵 위에 노출
 *   • ★ i18n 베타 = 영어 진입 X (★ 지금은 entry point 만)
 *
 * 구현:
 *   • AppShell header 의 profile menu 좌측에 globe 아이콘 + "한국어" 라벨
 *   • 클릭 시 작은 dropdown — "한국어 (현재)" / "English (베타 준비 중)"
 *   • "English" 클릭 → 진입 X, "i18n 베타 준비 중" 메시지 표시
 *
 * ★ 상태 저장 0 (현재): displayNames.ts 가 한국어 only — 영어 매핑 추가는
 *   후속 PR. 이번 PR 은 ★ 진입점 노출 + 사용자 가시화 만.
 */
function LanguageMenu() {
  const [open, setOpen] = useState(false);
  const [betaNotice, setBetaNotice] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      const node = ref.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // beta 안내 자동 dismiss (3s).
  useEffect(() => {
    if (!betaNotice) return;
    const id = window.setTimeout(() => setBetaNotice(false), 3000);
    return () => window.clearTimeout(id);
  }, [betaNotice]);

  return (
    <div
      ref={ref}
      style={{ position: 'relative' }}
      data-testid="app-shell-lang-container"
    >
      <button
        type="button"
        data-testid="app-shell-lang-trigger"
        aria-expanded={open}
        aria-label="언어 설정"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          borderRadius: 9,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: TEXT_BODY,
          fontSize: 13,
        }}
      >
        {/* Globe icon — inline SVG (외부 의존성 0) */}
        <svg
          width={16}
          height={16}
          viewBox="0 0 16 16"
          aria-hidden="true"
          style={{ display: 'block' }}
        >
          <circle
            cx={8}
            cy={8}
            r={6.5}
            fill="none"
            stroke={TEXT_SECONDARY}
            strokeWidth={1.2}
          />
          <ellipse
            cx={8}
            cy={8}
            rx={2.5}
            ry={6.5}
            fill="none"
            stroke={TEXT_SECONDARY}
            strokeWidth={1.2}
          />
          <line
            x1={1.5}
            y1={8}
            x2={14.5}
            y2={8}
            stroke={TEXT_SECONDARY}
            strokeWidth={1.2}
          />
        </svg>
        <span data-testid="app-shell-lang-current">한국어</span>
        <ChevronDown />
      </button>
      {open ? (
        <div
          role="menu"
          data-testid="app-shell-lang-menu"
          style={{
            position: 'absolute',
            top: 38,
            right: 0,
            width: 220,
            background: MENU_BG,
            border: `1px solid ${MENU_BORDER}`,
            borderRadius: 13,
            padding: 8,
            boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
            zIndex: 60,
          }}
        >
          <div
            style={{
              padding: '6px 10px 10px',
              fontSize: 11,
              letterSpacing: '0.14em',
              color: TEXT_DIM,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          >
            LANGUAGE
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="app-shell-lang-option-ko"
            onClick={() => setOpen(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '9px 10px',
              borderRadius: 8,
              fontSize: 14,
              color: ACCENT,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span>한국어</span>
            <span
              aria-hidden="true"
              style={{ fontSize: 12, color: ACCENT }}
            >
              현재
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="app-shell-lang-option-en"
            onClick={() => {
              // ★ PO 의뢰서 verbatim — "i18n 베타 = 영어 진입 X".
              // 진입점만 노출 → 클릭 시 안내 메시지 (자동 3s dismiss).
              setBetaNotice(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '9px 10px',
              borderRadius: 8,
              fontSize: 14,
              color: TEXT_BODY,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span>English</span>
            <span
              style={{
                fontSize: 11,
                color: TEXT_DIM,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                letterSpacing: '0.06em',
              }}
            >
              BETA
            </span>
          </button>
          {betaNotice ? (
            <div
              data-testid="app-shell-lang-beta-notice"
              role="status"
              style={{
                marginTop: 6,
                padding: '8px 10px',
                borderRadius: 8,
                background: `color-mix(in oklab, ${ACCENT} 8%, transparent)`,
                border: `1px solid color-mix(in oklab, ${ACCENT} 25%, transparent)`,
                color: TEXT_BODY,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              영어 모드는 베타 준비 중입니다. 곧 만나뵐게요.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProfileMenu({
  name,
  email,
}: {
  name: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      const node = containerRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  const initial = name.charAt(0) || '?';

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative' }}
      data-testid="app-shell-profile-container"
    >
      <button
        type="button"
        data-testid="app-shell-profile-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '5px 7px',
          borderRadius: 9,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: TEXT_BODY,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'color-mix(in oklab, #3fe0c6 15%, transparent)',
            border: '1px solid color-mix(in oklab, #3fe0c6 30%, transparent)',
            color: ACCENT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {initial}
        </span>
        <span style={{ fontSize: 14, fontWeight: 500, color: TEXT_BODY }}>
          {name}
        </span>
        <ChevronDown />
      </button>
      {open ? (
        <div
          role="menu"
          data-testid="app-shell-profile-menu"
          style={{
            position: 'absolute',
            top: 50,
            right: 0,
            width: 230,
            background: MENU_BG,
            border: `1px solid ${MENU_BORDER}`,
            borderRadius: 13,
            padding: 8,
            boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
            zIndex: 60,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px 10px',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'color-mix(in oklab, #3fe0c6 15%, transparent)',
                border:
                  '1px solid color-mix(in oklab, #3fe0c6 30%, transparent)',
                color: ACCENT,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {initial}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY }}>
                {name}
              </span>
              <span style={{ fontSize: 12, color: TEXT_DIM }}>{email}</span>
            </div>
          </div>
          <div style={{ height: 1, background: '#18222a', margin: '4px 0' }} />
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            style={{
              display: 'block',
              padding: '9px 10px',
              borderRadius: 8,
              fontSize: 14,
              color: '#bccacd',
              textDecoration: 'none',
            }}
          >
            설정
          </Link>
          <Link
            href="/imports"
            role="menuitem"
            onClick={() => setOpen(false)}
            style={{
              display: 'block',
              padding: '9px 10px',
              borderRadius: 8,
              fontSize: 14,
              color: '#bccacd',
              textDecoration: 'none',
            }}
          >
            가져오기 기록
          </Link>
          <div style={{ height: 1, background: '#18222a', margin: '4px 0' }} />
          <button
            type="button"
            role="menuitem"
            data-testid="app-shell-logout"
            onClick={async () => {
              setOpen(false);
              await logout();
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '9px 10px',
              borderRadius: 8,
              fontSize: 14,
              color: LOGOUT_RED,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            로그아웃
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NavLink({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  const showBadge = typeof item.count === 'number' && item.count > 0;
  const color = active ? ACCENT : TEXT_SECONDARY;
  return (
    <Link
      href={item.href}
      data-testid={`app-shell-nav-${item.href.replace(/^\//, '')}`}
      data-active={active ? 'true' : 'false'}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 4px',
        fontSize: 14,
        fontWeight: active ? 600 : 500,
        color,
        textDecoration: 'none',
        borderBottom: active ? `2px solid ${ACCENT}` : '2px solid transparent',
      }}
    >
      <span>{item.label}</span>
      {showBadge ? (
        <span
          data-testid={`app-shell-nav-badge-${item.href.replace(/^\//, '')}`}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: active ? ACCENT : TEXT_BODY,
          }}
        >
          ({item.count})
        </span>
      ) : null}
    </Link>
  );
}

export function AppShell({ children, userName, userEmail }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const { pendingCount } = useHomeBrief();
  // B-61 — prefer the authenticated identity from /api/auth/me when
  // available. Falls back to the prop overrides (tests) and finally
  // to the hardcoded design-mock defaults for the logged-out shell.
  const { me } = useAuthMe();
  const meName = me
    ? (me.display_name?.trim() || me.email.split('@')[0] || me.email)
    : null;
  const name = userName ?? meName ?? defaultUserName();
  const email = userEmail ?? me?.email ?? defaultUserEmail();

  // feat/i18n-ko-display-names-separation (★ PO 2026-06-30) —
  // 표시 라벨은 내부 코드네임 (HEARTH / RECALL / STELLAR / DECIDE / LEDGER)
  // 을 sectionLabelKo() 로 한국어 매핑 → 영문 코드 노출 0.
  // 내부 라우트 (/home, /recall, /stellar, /pending, /ledger) 는 코드네임
  // 유지 (회귀 0).
  const nav: NavItem[] = [
    { href: '/home', label: sectionLabelKo('HEARTH') },
    { href: '/recall', label: sectionLabelKo('RECALL') },
    // B-62 — Stellar 3D view is a top-level navigation target so PO can
    // jump in from anywhere without hand-typing the URL. No badge — there
    // are no count semantics on the canvas (recall has search, stellar
    // has the whole graph slice).
    { href: '/stellar', label: sectionLabelKo('STELLAR') },
    // feat/hearth-oracle-merge — "어시스턴트" tab removed. ORACLE is now
    // absorbed into HEARTH (the /home sphere). The /assistant route
    // redirects to /home for backwards compatibility with deep links.
    { href: '/pending', label: sectionLabelKo('DECIDE'), count: pendingCount },
    // feat/i18n-ko-display-names-separation — LEDGER (/ledger) 가 nav 의
    // primary 위치에서 노출되어야 한다는 PO 의뢰 (acceptance #1).
    { href: '/ledger', label: sectionLabelKo('LEDGER') },
  ];

  function isActive(href: string): boolean {
    if (href === '/home') {
      return pathname === '/' || pathname === '/home';
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div
      data-testid="app-shell"
      style={{
        minHeight: '100vh',
        background: BG,
        color: TEXT_PRIMARY,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        data-testid="app-shell-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 64,
          padding: '0 30px',
          borderBottom: `1px solid ${HEADER_BORDER}`,
          background: BG,
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
      >
        <Link
          href="/home"
          data-testid="app-shell-logo"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            textDecoration: 'none',
          }}
        >
          <LogoMark />
          <span
            style={{
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: TEXT_PRIMARY,
            }}
          >
            Lucid
          </span>
        </Link>
        <nav
          data-testid="app-shell-nav"
          aria-label="primary"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 28,
          }}
        >
          {nav.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} />
          ))}
        </nav>
        {/* REQ-009 — 언어 entry + profile menu 묶음 (★ 우측 상단 cluster). */}
        <div
          data-testid="app-shell-right-cluster"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <LanguageMenu />
          <ProfileMenu name={name} email={email} />
        </div>
      </header>
      <main
        data-testid="app-shell-main"
        style={{
          flex: 1,
          color: TEXT_PRIMARY,
        }}
      >
        {children}
      </main>
      {/* REQ-010 (★ PO 2026-06-30) — version 표기. 화면 하단 (★ 모든 페이지).
       *   • lib/version.ts 의 LUCID_VERSION = 0.MINOR dogfood 라운드 단위
       *   • 자동 표시 (수동 hardcode 0)
       *   • home 페이지의 home-version-footer 와 별도 (★ home 은 본문 내
       *     decorative 위치, AppShell 푸터는 모든 라우트 글로벌 chrome).
       */}
      <footer
        data-testid="app-shell-version-footer"
        style={{
          padding: '14px 30px',
          textAlign: 'center',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 11,
          letterSpacing: '0.06em',
          color: TEXT_DIMMER,
          borderTop: `1px solid ${HEADER_BORDER}`,
          background: BG,
        }}
      >
        Lucid v{LUCID_VERSION}
      </footer>
    </div>
  );
}
