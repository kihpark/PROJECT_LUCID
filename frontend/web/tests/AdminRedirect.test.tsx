import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    // Simulate Next.js redirect by throwing a special error
    const err = new Error(`NEXT_REDIRECT: ${url}`);
    (err as Error & { digest: string }).digest = `NEXT_REDIRECT;${url}`;
    throw err;
  }),
}));

import { redirect } from 'next/navigation';
import AdminPage from '@/app/admin/page';

describe('AdminPage redirect', () => {
  it('calls redirect to /admin/applications', () => {
    expect(() => AdminPage()).toThrow();
    expect(redirect).toHaveBeenCalledWith('/admin/applications');
  });

  it('throws a NEXT_REDIRECT error', () => {
    vi.mocked(redirect).mockClear();
    try {
      AdminPage();
    } catch (e) {
      const err = e as Error & { digest?: string };
      expect(err.digest ?? err.message).toContain('NEXT_REDIRECT');
    }
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});