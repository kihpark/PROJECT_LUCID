import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAuth, COOKIE_TOKEN, COOKIE_SPACE, WEB_BASE } from '@/lib/auth';

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
  tabs: { create: ReturnType<typeof vi.fn> };
};

interface CookieDetails {
  url: string;
  name: string;
}

beforeEach(() => {
  (chrome.cookies.get as ReturnType<typeof vi.fn>).mockReset();
});

describe('auth.getAuth', () => {
  it('returns null when either cookie is missing', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb(details.name === COOKIE_TOKEN ? ({ value: 'abc' } as chrome.cookies.Cookie) : null);
    });
    const auth = await getAuth();
    expect(auth).toBeNull();
  });

  it('returns both token + spaceId when present', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      const map: Record<string, string> = {
        [COOKIE_TOKEN]: 'jwt-xyz',
        [COOKIE_SPACE]: 'ks-1',
      };
      cb(map[details.name] ? ({ value: map[details.name] } as chrome.cookies.Cookie) : null);
    });
    const auth = await getAuth();
    expect(auth).toEqual({ token: 'jwt-xyz', spaceId: 'ks-1' });
  });

  it('reads cookies from the web app origin', async () => {
    chrome.cookies.get.mockImplementation((_d: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => cb(null));
    await getAuth();
    expect(chrome.cookies.get).toHaveBeenCalledWith(
      expect.objectContaining({ url: WEB_BASE, name: COOKIE_TOKEN }),
      expect.any(Function),
    );
  });
});
