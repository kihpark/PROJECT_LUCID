import { describe, it, expect, beforeEach, vi } from 'vitest';
import { postCapture } from '@/lib/api';
import { COOKIE_TOKEN, COOKIE_SPACE } from '@/lib/auth';

declare const chrome: {
  cookies: { get: ReturnType<typeof vi.fn> };
};

interface CookieDetails {
  url: string;
  name: string;
}

beforeEach(() => {
  chrome.cookies.get.mockReset();
  vi.unstubAllGlobals();
});

describe('postCapture', () => {
  it('rejects when no JWT is in the cookie', async () => {
    chrome.cookies.get.mockImplementation((_d: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => cb(null));
    await expect(
      postCapture({
        source_url: 'https://example.com',
        source_type: 'web_article',
        captured_from: 'chrome_ext',
      }),
    ).rejects.toThrow(/not_authenticated/);
  });

  it('sends a Bearer token + JSON body to /api/capture', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      const map: Record<string, string> = {
        [COOKIE_TOKEN]: 'jwt-xyz',
        [COOKIE_SPACE]: 'ks-1',
      };
      cb(map[details.name] ? ({ value: map[details.name] } as chrome.cookies.Cookie) : null);
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        job_id: 'job-1',
        status_url: '/api/jobs/job-1',
        status: 'pending_extract',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await postCapture({
      source_url: 'https://example.com',
      source_type: 'web_article',
      captured_from: 'chrome_ext',
    });
    expect(r.job_id).toBe('job-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/capture',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer jwt-xyz',
        }),
      }),
    );
  });

  it('surfaces backend detail on 4xx', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({ value: details.name === COOKIE_TOKEN ? 'jwt' : 'ks' } as chrome.cookies.Cookie);
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ detail: 'forbidden_source_url' }),
    }));
    await expect(
      postCapture({
        source_url: 'https://example.com',
        source_type: 'web_article',
        captured_from: 'chrome_ext',
      }),
    ).rejects.toThrow(/forbidden_source_url/);
  });
});
