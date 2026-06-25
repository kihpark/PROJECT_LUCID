/**
 * feat/state-sync-unification — sync bus regression.
 *
 * PO mandate: every display surface must refetch on a state change.
 * The bus is the single mechanism. These tests pin:
 *   - notifyStateChanged dispatches a window CustomEvent
 *   - notifyStateChanged also posts to BroadcastChannel('lucid-sync')
 *   - useStateChange subscribes and the handler fires on dispatch
 *   - the subscription unmounts cleanly (no orphaned listener)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { notifyStateChanged, useStateChange, __test__ } from '@/lib/sync';

const { SYNC_EVENT } = __test__;

describe('sync bus', () => {
  beforeEach(() => {
    // jsdom does have window but no BroadcastChannel — provide a stub
    // so the same-tab path stays the focus of these tests.
    if (typeof (globalThis as any).BroadcastChannel === 'undefined') {
      (globalThis as any).BroadcastChannel = class {
        public onmessage: ((e: MessageEvent) => void) | null = null;
        constructor(public name: string) {}
        postMessage(_data: unknown) {
          // no-op for the same-process test path
        }
        close() {}
      };
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifyStateChanged dispatches a window CustomEvent', () => {
    const handler = vi.fn();
    window.addEventListener(SYNC_EVENT, handler as EventListener);
    notifyStateChanged('decision-submitted', { jobId: 'job-1' });
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail.reason).toBe('decision-submitted');
    expect((evt.detail.payload as { jobId: string }).jobId).toBe('job-1');
    window.removeEventListener(SYNC_EVENT, handler as EventListener);
  });

  it('notifyStateChanged posts to BroadcastChannel("lucid-sync")', () => {
    const postSpy = vi.fn();
    const closeSpy = vi.fn();
    (globalThis as any).BroadcastChannel = class {
      public onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(public name: string) {}
      postMessage(data: unknown) {
        postSpy(data);
      }
      close() {
        closeSpy();
      }
    };
    notifyStateChanged('capture-submitted');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0]).toMatchObject({ reason: 'capture-submitted' });
    expect(closeSpy).toHaveBeenCalled();
  });

  it('useStateChange handler fires on dispatch', () => {
    const handler = vi.fn();
    renderHook(() => useStateChange(handler));
    act(() => {
      notifyStateChanged('fact-retracted', { factUid: 'f-1' });
    });
    expect(handler).toHaveBeenCalled();
    const event = handler.mock.calls[0][0];
    expect(event.reason).toBe('fact-retracted');
  });

  it('useStateChange removes its listener on unmount', () => {
    const handler = vi.fn();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useStateChange(handler));
    unmount();
    expect(
      removeSpy.mock.calls.some((c) => c[0] === SYNC_EVENT),
    ).toBe(true);
  });

  it('handles missing BroadcastChannel gracefully', () => {
    const original = (globalThis as any).BroadcastChannel;
    (globalThis as any).BroadcastChannel = undefined;
    // Should not throw even without the API present.
    expect(() => notifyStateChanged('fact-modified')).not.toThrow();
    (globalThis as any).BroadcastChannel = original;
  });
});
