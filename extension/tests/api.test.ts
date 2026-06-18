import { describe, it, expect, beforeEach, vi } from 'vitest';
import { describeApiError, postCapture } from '@/lib/api';
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

  // B-45-fix: the Pydantic 422 case used to render "[object Object]"
  // because `detail` is an array of error rows, not a string. Lock
  // in the pretty rendering.
  it('★ surfaces Pydantic 422 detail array as a readable line', async () => {
    chrome.cookies.get.mockImplementation((details: CookieDetails, cb: (c: chrome.cookies.Cookie | null) => void) => {
      cb({ value: details.name === COOKIE_TOKEN ? 'jwt' : 'ks' } as chrome.cookies.Cookie);
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        detail: [{
          type: 'value_error',
          loc: ['body', 'source_type'],
          msg: 'Input should be a valid SourceType',
        }],
      }),
    }));
    await expect(
      postCapture({
        source_url: 'https://example.com',
        source_type: 'web_article',
        captured_from: 'chrome_ext',
      }),
    ).rejects.toThrow(/Input should be a valid SourceType.*body\.source_type/);
  });
});

describe('describeApiError', () => {
  it('returns string detail verbatim', () => {
    expect(describeApiError({ detail: 'forbidden_source_url' }, 'fb'))
      .toBe('forbidden_source_url');
  });

  it('★ unpacks Pydantic 422 array shape (no [object Object])', () => {
    const body = {
      detail: [{
        type: 'value_error',
        loc: ['body', 'raw_payload_b64'],
        msg: 'Value error, raw_payload_b64_invalid',
      }],
    };
    const result = describeApiError(body, 'HTTP 422');
    expect(result).not.toMatch(/\[object Object\]/);
    expect(result).toContain('raw_payload_b64_invalid');
    expect(result).toContain('body.raw_payload_b64');
  });

  it('stringifies arbitrary object detail rather than [object Object]', () => {
    const result = describeApiError({ detail: { foo: 'bar', n: 3 } }, 'fb');
    expect(result).not.toMatch(/\[object Object\]/);
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('falls back when body has no detail', () => {
    expect(describeApiError({}, 'HTTP 500')).toBe('HTTP 500');
    expect(describeApiError(null, 'HTTP 500')).toBe('HTTP 500');
    expect(describeApiError(undefined, 'HTTP 500')).toBe('HTTP 500');
  });
});
