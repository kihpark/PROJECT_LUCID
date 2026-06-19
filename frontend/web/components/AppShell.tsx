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
import { useHomeBrief } from '@/lib/useHomeBrief';

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
  // A later ticket will swap this for a real auth-derived name.
  return '박기흥';
}

function defaultUserEmail(): string {
  return 'kihung@lucid.kr';
}

function logout(): void {
  // Reuse the existing auth.ts helpers so we don't fork token logic.
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
            onClick={() => {
              setOpen(false);
              logout();
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
  const name = userName ?? defaultUserName();
  const email = userEmail ?? defaultUserEmail();

  const nav: NavItem[] = [
    { href: '/home', label: '홈' },
    { href: '/recall', label: 'Recall' },
    { href: '/pending', label: '검증', count: pendingCount },
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
        <ProfileMenu name={name} email={email} />
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
      {/* Hidden anchor — keeps the unused TEXT_DIMMER token referenced so the
          design contract is visible. The README calls for it on dim captions. */}
      <span style={{ display: 'none' }} aria-hidden="true" data-color={TEXT_DIMMER} />
    </div>
  );
}
