/**
 * B-61-fix-admission — /admin/applications page contract.
 *
 * The page must:
 *   - redirect non-admin users to /home
 *   - list pending applications fetched from listApplications()
 *   - render approve buttons that call approveApplication() and reveal
 *     the one-time temp_password inline (input readOnly)
 *   - show a loading shim while useAuthMe is loading
 *   - show an empty state when no pending applications exist
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render, screen, fireEvent, waitFor, cleanup, act,
} from '@testing-library/react';

import type {
  ApplicationListItem,
  ApplicationsListResponse,
  ApproveResponse,
} from '@/lib/api';

// next/navigation
const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

// useAuthMe
type MeShape = {
  user_id: string;
  email: string;
  display_name?: string | null;
  default_space_id?: string | null;
  is_new_user: boolean;
  is_admin: boolean;
} | null;
const useAuthMeMock = vi.fn<[], { me: MeShape; loading: boolean; error: Error | null }>();
vi.mock('@/lib/useAuthMe', () => ({
  useAuthMe: () => useAuthMeMock(),
}));

// @/lib/api
const listApplicationsMock = vi.fn<[unknown?], Promise<ApplicationsListResponse>>();
const approveApplicationMock = vi.fn<[string], Promise<ApproveResponse>>();
vi.mock('@/lib/api', () => ({
  listApplications: (status?: string) => listApplicationsMock(status),
  approveApplication: (id: string) => approveApplicationMock(id),
}));

import AdminApplicationsPage from '@/app/admin/applications/page';

const ADMIN_ME = {
  user_id: 'u-admin',
  email: 'admin@lucid.example',
  display_name: 'Admin',
  default_space_id: 'ks-admin',
  is_new_user: false,
  is_admin: true,
};

const NON_ADMIN_ME = {
  user_id: 'u-user',
  email: 'user@lucid.example',
  display_name: 'User',
  default_space_id: 'ks-user',
  is_new_user: false,
  is_admin: false,
};

const SAMPLE_ITEMS: ApplicationListItem[] = [
  {
    application_id: 'app-001',
    email: 'a@example.com',
    profession: 'researcher',
    q1: 'I lose context.',
    q2: 'I cited a stat I cannot find.',
    lang: 'ko',
    status: 'pending',
    created_at: '2026-06-21T12:00:00Z',
  },
  {
    application_id: 'app-002',
    email: 'b@example.com',
    profession: 'lawyer',
    q1: null,
    q2: null,
    lang: 'en',
    status: 'pending',
    created_at: '2026-06-21T13:00:00Z',
  },
];

beforeEach(() => {
  replaceMock.mockReset();
  pushMock.mockReset();
  useAuthMeMock.mockReset();
  listApplicationsMock.mockReset();
  approveApplicationMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('AdminApplicationsPage', () => {
  it('redirects non-admin users to /home', async () => {
    useAuthMeMock.mockReturnValue({ me: NON_ADMIN_ME, loading: false, error: null });
    listApplicationsMock.mockResolvedValue({ items: [], total: 0 });

    render(<AdminApplicationsPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/home');
    });
    // List endpoint MUST NOT be hit for non-admins.
    expect(listApplicationsMock).not.toHaveBeenCalled();
  });

  it('renders the list when caller is admin', async () => {
    useAuthMeMock.mockReturnValue({ me: ADMIN_ME, loading: false, error: null });
    listApplicationsMock.mockResolvedValue({ items: SAMPLE_ITEMS, total: 2 });

    render(<AdminApplicationsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-applications-table')).toBeInTheDocument();
    });
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('b@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('approve-app-001')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('approve button calls API and shows the temp_password inline', async () => {
    useAuthMeMock.mockReturnValue({ me: ADMIN_ME, loading: false, error: null });
    listApplicationsMock.mockResolvedValue({ items: SAMPLE_ITEMS, total: 2 });
    approveApplicationMock.mockResolvedValue({
      application_id: 'app-001',
      user_id: 'u-new',
      email: 'a@example.com',
      temp_password: 'tmp-pass-1234567890',
      already_existed: false,
      status: 'approved',
    });

    render(<AdminApplicationsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('approve-app-001')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('approve-app-001'));
    });

    await waitFor(() => {
      expect(approveApplicationMock).toHaveBeenCalledWith('app-001');
    });

    const reveal = await screen.findByTestId('temp-password-app-001');
    expect(reveal).toHaveValue('tmp-pass-1234567890');
    // The "한 번만 표시" warning is rendered alongside the password.
    expect(screen.getByText(/한 번만 표시/)).toBeInTheDocument();
  });

  it('shows the loading shim while useAuthMe is loading', () => {
    useAuthMeMock.mockReturnValue({ me: null, loading: true, error: null });

    render(<AdminApplicationsPage />);

    expect(screen.getByTestId('admin-applications-loading')).toBeInTheDocument();
    expect(listApplicationsMock).not.toHaveBeenCalled();
  });

  it('shows the empty state when there are no pending applications', async () => {
    useAuthMeMock.mockReturnValue({ me: ADMIN_ME, loading: false, error: null });
    listApplicationsMock.mockResolvedValue({ items: [], total: 0 });

    render(<AdminApplicationsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-applications-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-applications-table')).not.toBeInTheDocument();
  });
});
