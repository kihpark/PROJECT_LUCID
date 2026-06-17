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

describe('toast renderInitial — localised copy (B-36)', () => {
  it('renders the Saving state for pending_extract', () => {
    __test__.renderInitial('pending_extract', 'job-1234abcd', undefined);
    const root = document.querySelector('.lucid-toast-root');
    expect(root?.querySelector('.lucid-toast-status')?.textContent).toMatch(/Lucid 에 저장/);
    expect(root?.querySelector('.lucid-toast-detail')?.textContent).toContain('job-1234');
  });

  it('renders the failure state for capture_failed', () => {
    __test__.renderInitial('capture_failed', undefined, 'not_authenticated');
    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/저장 실패/);
    expect(status?.className).toContain('lucid-toast-error');
    expect(document.querySelector('.lucid-toast-detail')?.textContent).toBe(
      'not_authenticated',
    );
  });

  it('renders the Analyzing state for structuring', () => {
    __test__.renderInitial('structuring', 'job-zzz', undefined);
    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/분석 중/);
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

    await vi.advanceTimersByTimeAsync(1000);
    await vi.runOnlyPendingTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'get_job_status', job_id: 'job-x' }),
    );
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

    await vi.advanceTimersByTimeAsync(61_000);
    await vi.runOnlyPendingTimersAsync();

    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/처리 지연/);
  });
});

describe('toast completion summary (B-36)', () => {
  it('shows "N건 추출됨" + 검토하기 link when fact_count > 0', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'get_job_status') {
        return Promise.resolve({ ok: true, body: { status: 'structured' } });
      }
      if (msg.type === 'get_structured_summary') {
        return Promise.resolve({
          ok: true,
          summary: { fact_count: 7, object_count: 3, has_disambiguation: false },
        });
      }
      return Promise.resolve({ ok: false });
    });

    __test__.renderInitial('pending_extract', 'job-good', undefined);
    __test__.startPolling('job-good');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runOnlyPendingTimersAsync();

    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/분석 완료/);
    const detail = document.querySelector('.lucid-toast-detail');
    expect(detail?.textContent).toMatch(/7건 추출됨/);
    // The Review affordance is a clickable button.
    expect(detail?.querySelector('button')?.textContent).toMatch(/검토하기/);
  });

  it('shows "추출된 사실 없음" + 검토하기 when fact_count is 0', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'get_job_status') {
        return Promise.resolve({ ok: true, body: { status: 'structured' } });
      }
      if (msg.type === 'get_structured_summary') {
        return Promise.resolve({
          ok: true,
          summary: { fact_count: 0, object_count: 0, has_disambiguation: false },
        });
      }
      return Promise.resolve({ ok: false });
    });

    __test__.renderInitial('pending_extract', 'job-zero', undefined);
    __test__.startPolling('job-zero');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runOnlyPendingTimersAsync();

    const status = document.querySelector('.lucid-toast-status');
    expect(status?.textContent).toMatch(/분석 완료/);
    const detail = document.querySelector('.lucid-toast-detail');
    expect(detail?.textContent).toMatch(/추출된 사실 없음/);
    // Even on a 0-facts result the user can still click through to
    // confirm what was decomposed (or not).
    expect(detail?.querySelector('button')?.textContent).toMatch(/검토하기/);
  });

  it('shows just the 검토하기 link when the summary fetch fails', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'get_job_status') {
        return Promise.resolve({ ok: true, body: { status: 'structured' } });
      }
      // summary fetch errors out
      return Promise.resolve({ ok: false, error: 'summary_unavailable' });
    });

    __test__.renderInitial('pending_extract', 'job-err', undefined);
    __test__.startPolling('job-err');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runOnlyPendingTimersAsync();

    const detail = document.querySelector('.lucid-toast-detail');
    // No prefix text — just the button. The status itself says 분석 완료.
    expect(detail?.querySelector('button')?.textContent).toMatch(/검토하기/);
  });
});
