'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ActionButton } from './ActionButton';
import { registerUser, ApiError } from '@/lib/api';
import { setToken, setCurrentSpace } from '@/lib/auth';

/**
 * B-61 — register form.
 *
 * Mirrors LoginForm structure (so the visual chrome of /login and
 * /register stays in lockstep). On success: setToken + setCurrentSpace
 * + redirect to /home so the user lands on the cold-start surface
 * with the welcome line already wired.
 *
 * Error mapping:
 *   409 → "이미 가입된 이메일입니다." (server detail `email_already_registered`)
 *   422 → field-level validation (pydantic detail, surfaced as-is)
 *   other → the ApiError.detail / message
 */
export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const resp = await registerUser({
        email,
        password,
        name: name.trim() || null,
      });
      setToken(resp.access_token);
      setCurrentSpace(resp.space_id);
      router.push('/home');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError('이미 가입된 이메일입니다.');
        } else if (err.status === 422) {
          setError(err.detail ?? '입력을 다시 확인해 주세요.');
        } else {
          setError(err.detail ?? err.message);
        }
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4"
      data-testid="register-form"
    >
      <div>
        <label
          className="block text-xs text-text-secondary mb-1"
          htmlFor="register-email"
        >
          Email
        </label>
        <input
          id="register-email"
          data-testid="register-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border-subtle bg-bg-card p-2 text-sm focus:outline-none focus:border-accent-cool"
        />
      </div>
      <div>
        <label
          className="block text-xs text-text-secondary mb-1"
          htmlFor="register-password"
        >
          Password
        </label>
        <input
          id="register-password"
          data-testid="register-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-border-subtle bg-bg-card p-2 text-sm focus:outline-none focus:border-accent-cool"
        />
      </div>
      <div>
        <label
          className="block text-xs text-text-secondary mb-1"
          htmlFor="register-name"
        >
          표시 이름 (선택)
        </label>
        <input
          id="register-name"
          data-testid="register-name"
          type="text"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-border-subtle bg-bg-card p-2 text-sm focus:outline-none focus:border-accent-cool"
        />
      </div>
      {error && (
        <p
          role="alert"
          data-testid="register-error"
          className="text-accent-error text-xs"
        >
          {error}
        </p>
      )}
      <ActionButton
        type="submit"
        variant="primary"
        disabled={busy}
        className="w-full"
      >
        {busy ? '가입 중...' : '가입하기'}
      </ActionButton>
      <p className="text-xs text-text-secondary text-center pt-2">
        이미 계정이 있으신가요?{' '}
        <Link
          href="/login"
          data-testid="register-to-login-link"
          className="underline"
        >
          로그인
        </Link>
      </p>
    </form>
  );
}
