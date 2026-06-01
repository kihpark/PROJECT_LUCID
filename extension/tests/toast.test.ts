import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __test__ } from '@/content/toast';

declare const chrome: {
  runtime: { sendMessage: ReturnType<typeof vi.fn>; onMessage: { addListener: ReturnType<typeof vi.fn> } };
};

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
  __test__.reset();
  vi.useRealTimers();
  chrome.runtime.sendMessage.mockReset();
});

describe('toast renderInitial', () => {
  it('renders the Saving... state for pending_extract', () => {
    __test__.renderInitial('pending_extract', 'job-1234abcd', undefined);
    const root = document.querySelector('.lucid-toast-root');
    expect(root?.querySelector('.lucid-toast-status')?.textContent).toMatch(/Saving/);
    expect(root?.querySelector('.lucid-toast-detail')?.textContent).toContain('job-1234');
  });

  it('renders the Save failed state for capture_failed', () => {
    __test__.renderInitial('capture_failed', undefined, 'not_authenticated');
    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/Save failed/);
    expect(status?.className).toContain('lucid-toast-error');
    expect(document.querySelector('.lucid-toast-detail')?.textContent).toBe(
      'not_authenticated',
    );
  });
});

describe('toast polling', () => {
  it('polls get_job_status and stops on a terminal status', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'get_job_status') {
        return Promise.resolve({ ok: true, body: { status: 'structured' } });
      }
      if (msg.type === 'get_structured_summary') {
        return Promise.resolve({
          ok: true,
          summary: { fact_count: 5, object_count: 3, has_disambiguation: false },
        });
      }
      return Promise.resolve({ ok: false });
    });

    __test__.renderInitial('pending_extract', 'job-x', undefined);
    __test__.startPolling('job-x');

    // Advance to the first poll tick.
    await vi.advanceTimersByTimeAsync(1000);
    // Microtasks for the structured + summary chain to settle.
    await vi.runOnlyPendingTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'get_job_status', job_id: 'job-x' }),
    );
    // After a terminal status the timer is stopped — advancing further
    // should not produce more sendMessage calls.
    const callsAfterTerminal = chrome.runtime.sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(chrome.runtime.sendMessage.mock.calls.length).toBeLessThanOrEqual(
      callsAfterTerminal + 1,
    );
  });

  it('stops polling after POLL_MAX_ATTEMPTS attempts', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: true,
      body: { status: 'structuring' },
    });

    __test__.renderInitial('pending_extract', 'job-y', undefined);
    __test__.startPolling('job-y');

    // 60 poll ticks of 1 s + buffer.
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.runOnlyPendingTimersAsync();

    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/Still working/);
  });
});
