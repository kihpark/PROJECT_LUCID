/**
 * Auth bridge — chrome.cookies.get reads the lucid_jwt / lucid_space_id
 * cookies the web app set on /login (Sprint 4A lib/auth.setToken). The
 * extension never touches the web app's localStorage; the cookie mirror
 * is the contract (DR-068).
 */

export interface AuthInfo {
  token: string;
  spaceId: string;
}

export const WEB_BASE = 'http://localhost:3000';
export const COOKIE_TOKEN = 'lucid_jwt';
export const COOKIE_SPACE = 'lucid_space_id';

async function getCookie(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url: WEB_BASE, name }, (cookie) => {
        resolve(cookie?.value ? decodeURIComponent(cookie.value) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function getAuth(): Promise<AuthInfo | null> {
  const token = await getCookie(COOKIE_TOKEN);
  const spaceId = await getCookie(COOKIE_SPACE);
  if (!token || !spaceId) return null;
  return { token, spaceId };
}

export function openLogin(): void {
  chrome.tabs.create({ url: `${WEB_BASE}/login` });
}
