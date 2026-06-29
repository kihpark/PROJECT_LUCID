/**
 * ★ V1 (HOME sync 위반 클래스) tests — useHomeBrief.
 *
 * Pin the auto-refetch behaviour:
 *   1. mount → 1 getHomeBrief call.
 *   2. document.visibilitychange (visibilityState='visible') → refetch.
 *   3. window 'focus' → refetch.
 *   4. notifyStateChanged('capture-submitted') → refetch (regression).
 *
 * Principle test: no hardcoded user content. We only assert on call counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the api module before importing the hook.
vi.mock('@/lib/api', () => ({
  getHomeBrief: vi.fn(),
}));

import * as api from '@/lib/api';
import { useHomeBrief } from '@/lib/useHomeBrief';
import { notifyStateChanged } from '@/lib/sync';

const brief = {
  totals: { facts: 0, entities: 0, sources: 0, this_week: 0 },
  pending_validation: 0,
  recent_validated: [],
  top_cluster: null,
  is_empty: true,
};

beforeEach(() => {
  (api.getHomeBrief as ReturnType<typeof vi.fn>).mockReset();
  (api.getHomeBrief as ReturnType<typeof vi.fn>).mockResolvedValue(brief);
});

function flushMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('useHomeBrief (★ V1 HOME sync 위반 클래스)', () => {
  it('fires getHomeBrief once on mount', async () => {
    renderHook(() => useHomeBrief());
    await act(async () => { await flushMicrotasks(); });
    expect((api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('re-fetches on document visibilitychange when visibilityState="visible"', async () => {
    renderHook(() => useHomeBrief());
    await act(async () => { await flushMicrotasks(); });
    const before = (api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });
    const after = (api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after).toBeGreaterThan(before);
  });

  it('re-fetches on window focus', async () => {
    renderHook(() => useHomeBrief());
    await act(async () => { await flushMicrotasks(); });
    const before = (api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushMicrotasks();
    });
    const after = (api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after).toBeGreaterThan(before);
  });

  it('re-fetches on notifyStateChanged (regression guard)', async () => {
    renderHook(() => useHomeBrief());
    await act(async () => { await flushMicrotasks(); });
    const before = (api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      notifyStateChanged('capture-submitted');
      await flushMicrotasks();
    });
    const after = (api.getHomeBrief as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after).toBeGreaterThan(before);
  });
});
