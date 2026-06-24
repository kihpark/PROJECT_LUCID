/**
 * B-57 — frontend app shell + 3-verb nav.
 *
 * The shell is rendered around every route. Tests cover:
 *  - structural pieces present (logo, nav, profile button)
 *  - active-route highlight by pathname
 *  - profile dropdown open / outside-mousedown close
 *  - 검증 nav badge driven by /api/home/brief, fail-soft when the endpoint
 *    is unavailable (B-55 may not be merged yet).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// next/navigation usePathname is mocked per-test so we can drive the active
// highlight. Default to '/' so structural tests get a defined pathname.
const pathnameRef = { current: '/' as string };
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
}));

// next/link — render the bare anchor so jsdom can read href and click.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => {
    return (
      <a href={href} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },
}));

// Mock the api module — getHomeBrief drives the badge, logoutUser is
// invoked by the new B-61 logout flow.
vi.mock('@/lib/api', () => ({
  getHomeBrief: vi.fn(),
  logoutUser: vi.fn(),
}));

// B-61 — useAuthMe hook drives the AppShell identity. Default is "no
// authenticated me" so the existing tests keep the design-mock defaults.
// Individual tests override via useAuthMeMock.mockReturnValue(...).
const useAuthMeMock = vi.fn(() => ({ me: null, loading: false, error: null }));
vi.mock('@/lib/useAuthMe', () => ({
  useAuthMe: () => useAuthMeMock(),
}));

// B-61 — auth.ts helpers are called during logout. Observe them.
const clearTokenMock = vi.fn();
const clearCurrentSpaceMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  clearToken: () => clearTokenMock(),
  clearCurrentSpace: () => clearCurrentSpaceMock(),
}));

import * as api from '@/lib/api';
import { AppShell } from '@/components/AppShell';

const noBrief = { totals: { facts: 0, entities: 0, sources: 0, this_week: 0 }, pending_validation: 0, recent_validated: [], top_cluster: null, is_empty: true };

function mockBrief(pending: number) {
  (api.getHomeBrief as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...noBrief,
    pending_validation: pending,
    is_empty: pending === 0,
  });
}

beforeEach(() => {
  pathnameRef.current = '/';
  (api.getHomeBrief as ReturnType<typeof vi.fn>).mockReset();
  (api.logoutUser as ReturnType<typeof vi.fn>).mockReset();
  (api.logoutUser as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  // Default: fail-soft (no brief). Individual tests can override.
  (api.getHomeBrief as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('not wired'),
  );
  useAuthMeMock.mockReset();
  useAuthMeMock.mockReturnValue({ me: null, loading: false, error: null });
  clearTokenMock.mockReset();
  clearCurrentSpaceMock.mockReset();
  // Pin window.location.href so the logout redirect doesn't navigate
  // the jsdom window mid-test.
  // @ts-expect-error — jsdom Location is rebindable here.
  delete (window as { location?: Location }).location;
  // @ts-expect-error — minimal Location stub.
  window.location = { href: '' } as Location;
});

afterEach(() => {
  cleanup();
});

describe('AppShell', () => {
  it('renders logo, nav, and profile button', async () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    expect(screen.getByTestId('app-shell-logo')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-logo-mark')).toBeInTheDocument();
    expect(screen.getByText('Lucid')).toBeInTheDocument();

    const nav = screen.getByTestId('app-shell-nav');
    expect(nav).toBeInTheDocument();
    // four nav items in this order: 홈 / Recall / Stellar / 검증 (B-62)
    expect(screen.getByTestId('app-shell-nav-home')).toHaveTextContent('홈');
    expect(screen.getByTestId('app-shell-nav-recall')).toHaveTextContent(
      'Recall',
    );
    expect(screen.getByTestId('app-shell-nav-stellar')).toHaveTextContent(
      'Stellar',
    );
    expect(screen.getByTestId('app-shell-nav-pending')).toHaveTextContent(
      '검증',
    );

    expect(
      screen.getByTestId('app-shell-profile-trigger'),
    ).toBeInTheDocument();
  });

  it('feat/hearth-oracle-merge — "어시스턴트" nav tab is removed (ORACLE absorbed into HEARTH)', () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );
    // The /assistant route still exists (it redirects to /home), but
    // it no longer appears in the top nav.
    expect(screen.queryByTestId('app-shell-nav-assistant')).not.toBeInTheDocument();
    const nav = screen.getByTestId('app-shell-nav');
    expect(nav.textContent).not.toContain('어시스턴트');
  });

  it('active route highlights the matching nav item', async () => {
    pathnameRef.current = '/recall';
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    expect(screen.getByTestId('app-shell-nav-recall')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('app-shell-nav-home')).toHaveAttribute(
      'data-active',
      'false',
    );
    expect(screen.getByTestId('app-shell-nav-pending')).toHaveAttribute(
      'data-active',
      'false',
    );
  });

  it('profile menu opens on click and closes on outside mousedown', async () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    expect(
      screen.queryByTestId('app-shell-profile-menu'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('app-shell-profile-trigger'));
    expect(
      screen.getByTestId('app-shell-profile-menu'),
    ).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(
        screen.queryByTestId('app-shell-profile-menu'),
      ).not.toBeInTheDocument(),
    );
  });

  it('검증 nav shows count when pending_validation > 0', async () => {
    mockBrief(3);
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('app-shell-nav-badge-pending'),
      ).toBeInTheDocument(),
    );
    const pendingNav = screen.getByTestId('app-shell-nav-pending');
    expect(pendingNav.textContent).toContain('(3)');
  });

  it('검증 nav shows no badge when pending_validation == 0', async () => {
    mockBrief(0);
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    // wait a tick to let the useEffect run
    await waitFor(() =>
      expect(api.getHomeBrief).toHaveBeenCalled(),
    );
    expect(
      screen.queryByTestId('app-shell-nav-badge-pending'),
    ).not.toBeInTheDocument();
    const pendingNav = screen.getByTestId('app-shell-nav-pending');
    expect(pendingNav.textContent).not.toContain('(');
  });

  it('검증 nav stays at zero when /api/home/brief is unavailable', async () => {
    (api.getHomeBrief as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('404 not found'),
    );
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    await waitFor(() =>
      expect(api.getHomeBrief).toHaveBeenCalled(),
    );
    // Fail-soft: no badge, no crash
    expect(
      screen.queryByTestId('app-shell-nav-badge-pending'),
    ).not.toBeInTheDocument();
    const pendingNav = screen.getByTestId('app-shell-nav-pending');
    expect(pendingNav.textContent).toBe('검증');
  });

  // -------------------------------------------------------------------------
  // B-61 — multi-user gate
  // -------------------------------------------------------------------------

  it('B-61 — 로그아웃 click calls logoutUser + clearToken + clearCurrentSpace + redirects', async () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByTestId('app-shell-profile-trigger'));
    const logoutBtn = screen.getByTestId('app-shell-logout');
    fireEvent.click(logoutBtn);

    await waitFor(() =>
      expect(api.logoutUser).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(clearTokenMock).toHaveBeenCalledTimes(1));
    expect(clearCurrentSpaceMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(window.location.href).toBe('/login'),
    );
  });

  it('B-61 — renders me.email when useAuthMe returns a me object', async () => {
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-1',
        email: 'kihpark85@gmail.com',
        display_name: 'Kih Park',
        default_space_id: 's-1',
        is_new_user: false,
      },
      loading: false,
      error: null,
    });

    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    // Open the dropdown so the email is in the DOM.
    fireEvent.click(screen.getByTestId('app-shell-profile-trigger'));
    const menu = screen.getByTestId('app-shell-profile-menu');
    expect(menu).toHaveTextContent('kihpark85@gmail.com');
    // The default literal MUST NOT leak when an authenticated identity
    // is available.
    expect(menu).not.toHaveTextContent('kihpark85@lucid.kr');
    expect(menu).not.toHaveTextContent('kihung@lucid.kr');
  });
});
