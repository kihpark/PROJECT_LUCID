'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionButton } from './ActionButton';
import { loginUser, getMySpaces, ApiError } from '@/lib/api';
import { setToken, setCurrentSpace } from '@/lib/auth';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tokenResp = await loginUser({ email, password });
      setToken(tokenResp.access_token);
      const spaces = await getMySpaces();
      if (spaces.length === 0) {
        setError('No KnowledgeSpace found for this account.');
        setBusy(false);
        return;
      }
      setCurrentSpace(spaces[0]!.id);
      router.push('/pending');
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border-subtle bg-bg-card p-2 text-sm focus:outline-none focus:border-accent-cool"
        />
      </div>
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-border-subtle bg-bg-card p-2 text-sm focus:outline-none focus:border-accent-cool"
        />
      </div>
      {error && (
        <p role="alert" className="text-accent-error text-xs">
          {error}
        </p>
      )}
      <ActionButton type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? 'Signing in...' : 'Sign in'}
      </ActionButton>
    </form>
  );
}
