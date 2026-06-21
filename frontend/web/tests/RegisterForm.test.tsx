/**
 * B-61 — RegisterForm contract.
 *
 * The form must:
 *   - POST through registerUser({email, password, name})
 *   - setToken + setCurrentSpace on success
 *   - router.push('/home') after success (so the cold-start welcome
 *     line is the user's first view)
 *   - surface a Korean error message on 409 ("이미 가입된 이메일입니다.")
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render, screen, fireEvent, waitFor, cleanup,
} from '@testing-library/react';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href, children, ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, unknown>)}>{children}</a>
  ),
}));

const setTokenMock = vi.fn();
const setCurrentSpaceMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  setToken: (t: string) => setTokenMock(t),
  setCurrentSpace: (s: string) => setCurrentSpaceMock(s),
}));

const registerUserMock = vi.fn();
vi.mock('@/lib/api', () => {
  class FakeApiError extends Error {
    status: number;
    detail?: string;
    constructor(message: string, status: number, detail?: string) {
      super(message);
      this.status = status;
      this.detail = detail;
    }
  }
  return {
    registerUser: (body: unknown) => registerUserMock(body),
    ApiError: FakeApiError,
  };
});
// Pull the same class out for use in test bodies (e.g., throwing 409).
import { ApiError as MockedApiError } from '@/lib/api';

import { RegisterForm } from '@/components/RegisterForm';

beforeEach(() => {
  pushMock.mockReset();
  setTokenMock.mockReset();
  setCurrentSpaceMock.mockReset();
  registerUserMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('RegisterForm', () => {
  it('renders email, password, name fields and a submit button', () => {
    render(<RegisterForm />);
    expect(screen.getByTestId('register-email')).toBeInTheDocument();
    expect(screen.getByTestId('register-password')).toBeInTheDocument();
    expect(screen.getByTestId('register-name')).toBeInTheDocument();
    expect(screen.getByText('가입하기')).toBeInTheDocument();
    expect(screen.getByTestId('register-to-login-link')).toHaveAttribute(
      'href', '/login',
    );
  });

  it('submits → setToken + setCurrentSpace + router.push("/home")', async () => {
    registerUserMock.mockResolvedValue({
      user: { id: 'u-1', email: 'new@example.com', name: 'New User' },
      space_id: 's-1',
      access_token: 'jwt-token',
      token_type: 'bearer',
      expires_in: 3600,
    });

    render(<RegisterForm />);

    fireEvent.change(screen.getByTestId('register-email'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByTestId('register-password'), {
      target: { value: 'longerthan8chars!' },
    });
    fireEvent.change(screen.getByTestId('register-name'), {
      target: { value: 'New User' },
    });
    fireEvent.submit(screen.getByTestId('register-form'));

    await waitFor(() => expect(registerUserMock).toHaveBeenCalledTimes(1));
    expect(registerUserMock).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'longerthan8chars!',
      name: 'New User',
    });
    await waitFor(() => expect(setTokenMock).toHaveBeenCalledWith('jwt-token'));
    expect(setCurrentSpaceMock).toHaveBeenCalledWith('s-1');
    expect(pushMock).toHaveBeenCalledWith('/home');
  });

  it('shows Korean error on 409 (duplicate email)', async () => {
    registerUserMock.mockRejectedValue(
      new MockedApiError('conflict', 409, 'email_already_registered'),
    );

    render(<RegisterForm />);

    fireEvent.change(screen.getByTestId('register-email'), {
      target: { value: 'dupe@example.com' },
    });
    fireEvent.change(screen.getByTestId('register-password'), {
      target: { value: 'longerthan8chars!' },
    });
    fireEvent.submit(screen.getByTestId('register-form'));

    await waitFor(() => {
      expect(screen.getByTestId('register-error')).toHaveTextContent(
        '이미 가입된 이메일입니다.',
      );
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('sends name=null when the optional name field is empty', async () => {
    registerUserMock.mockResolvedValue({
      user: { id: 'u-2', email: 'a@b.com', name: null },
      space_id: 's-2',
      access_token: 'jwt2',
      token_type: 'bearer',
      expires_in: 3600,
    });

    render(<RegisterForm />);

    fireEvent.change(screen.getByTestId('register-email'), {
      target: { value: 'a@b.com' },
    });
    fireEvent.change(screen.getByTestId('register-password'), {
      target: { value: 'longerthan8chars!' },
    });
    fireEvent.submit(screen.getByTestId('register-form'));

    await waitFor(() => expect(registerUserMock).toHaveBeenCalledTimes(1));
    const arg = registerUserMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.name).toBeNull();
  });
});
