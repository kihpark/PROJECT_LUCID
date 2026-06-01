/**
 * chrome.storage.local wrapper. The service worker uses this to cache
 * the user's space_id (read from the cookie at first launch) so the
 * popup doesn't need to re-fetch /api/spaces/me on every open.
 */

interface CachedState {
  spaceId?: string;
  email?: string;
  capturedJobIds?: string[];
}

const KEY = 'lucid_state';

export async function readState(): Promise<CachedState> {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY], (result) => {
      resolve((result?.[KEY] as CachedState) || {});
    });
  });
}

export async function writeState(patch: Partial<CachedState>): Promise<void> {
  const current = await readState();
  const next = { ...current, ...patch };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [KEY]: next }, () => resolve());
  });
}

export async function clearState(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([KEY], () => resolve());
  });
}
