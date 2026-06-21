/**
 * feat/landing-fix-spec — RootRedirect (`app/page.tsx`) test.
 *
 * The root `/` route was reclaimed from landing-integration's
 * `/landing-v82.html` redirect and is now auth-aware:
 *   - `useAuthMe()` resolved + me === null      -> /login
 *   - `useAuthMe()` resolved + me has a user_id -> /home
 *   - `useAuthMe()` still loading               -> no router call yet
 *
 * Why mock at module boundaries: same pattern as HomePage.test.tsx —
 * mocking `useAuthMe` and `next/navigation.useRouter` lets us assert
 * the redirect decision in isolation, without dragging the token
 * machinery into the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

const useAuthMeMock = vi.fn();
vi.mock('@/lib/useAuthMe', () => ({
  useAuthMe: () => useAuthMeMock(),
}));

import RootRedirect from '@/app/page';

beforeEach(() => {
  replaceMock.mockClear();
  useAuthMeMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('RootRedirect', () => {
  it('redirects unauthenticated visitors to /login', () => {
    useAuthMeMock.mockReturnValue({ me: null, loading: false, error: null });
    render(<RootRedirect />);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/login');
  });

  it('redirects authenticated visitors to /home', () => {
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-1',
        email: 'a@b.com',
        display_name: 'A',
        default_space_id: 's-1',
        is_new_user: false,
      },
      loading: false,
      error: null,
    });
    render(<RootRedirect />);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/home');
  });

  it('does not redirect while useAuthMe is still loading', () => {
    useAuthMeMock.mockReturnValue({ me: null, loading: true, error: null });
    render(<RootRedirect />);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
