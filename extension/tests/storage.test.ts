import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readState, writeState, clearState } from '@/lib/storage';

declare const chrome: {
  storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } };
};

const KEY = 'lucid_state';

beforeEach(() => {
  chrome.storage.local.get.mockReset();
  chrome.storage.local.set.mockReset();
  chrome.storage.local.remove.mockReset();
});

describe('storage wrapper', () => {
  it('reads the cached state', async () => {
    chrome.storage.local.get.mockImplementation((_keys: string[], cb: (r: Record<string, unknown>) => void) => {
      cb({ [KEY]: { spaceId: 'ks-1' } });
    });
    const s = await readState();
    expect(s).toEqual({ spaceId: 'ks-1' });
  });

  it('merges a patch into the existing state', async () => {
    chrome.storage.local.get.mockImplementation((_keys: string[], cb: (r: Record<string, unknown>) => void) => {
      cb({ [KEY]: { spaceId: 'ks-1' } });
    });
    chrome.storage.local.set.mockImplementation((_obj: Record<string, unknown>, cb: () => void) => cb());
    await writeState({ email: 'a@b.c' });
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { [KEY]: { spaceId: 'ks-1', email: 'a@b.c' } },
      expect.any(Function),
    );
  });

  it('clears state', async () => {
    chrome.storage.local.remove.mockImplementation((_keys: string[], cb: () => void) => cb());
    await clearState();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([KEY], expect.any(Function));
  });
});
