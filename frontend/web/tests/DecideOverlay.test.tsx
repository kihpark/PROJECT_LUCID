import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DecideOverlay } from '@/components/DecideOverlay';
import type { PendingJobDetail } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  acceptAll: vi.fn(),
  discardJob: vi.fn(async () => ({
    accepted_facts: [],
    edited_facts: [],
    discarded_facts: ['fn-1', 'fn-2'],
    created_objects: [],
    merged_objects: [],
    skipped_objects: [],
    validation_log_count: 1,
  })),
  submitDecisions: vi.fn(async (_s: string, _j: string, payload: { decisions: Array<{ fact_uid: string; action: string; edited_claim?: string }> }) => ({
    accepted_facts: payload.decisions
      .filter((d) => d.action === 'accept')
      .map((d) => d.fact_uid),
    edited_facts: payload.decisions
      .filter((d) => d.action === 'edit')
      .map((d) => d.fact_uid),
    discarded_facts: payload.decisions
      .filter((d) => d.action === 'discard')
      .map((d) => d.fact_uid),
    created_objects: [],
    merged_objects: [],
    skipped_objects: [],
    validation_log_count: payload.decisions.length,
  })),
  searchEntitySuggestions: vi.fn(async () => []),
  listPredicates: vi.fn(async () => []),
}));

import * as api from '@/lib/api';

const baseJob: PendingJobDetail = {
  job_id: 'job-xyz',
  source_url: 'https://example.com/article',
  source_type: 'web_article',
  captured_at: new Date('2026-06-16T00:00:00Z').toISOString(),
  captured_from: 'chrome_ext',
  knowledge_space_id: 'ks-1',
  extracted_text_preview: 'Some preview',
  facts: [
    {
      fact_uid: 'fn-1',
      claim: 'KR claim 1',
      claim_en: 'EN claim 1',
      subject_uid: 'obj-1',
      predicate: 'is_a',
      object_value: 'thing',
    },
    {
      fact_uid: 'fn-2',
      claim: 'KR claim 2',
      claim_en: 'EN claim 2',
      subject_uid: 'obj-1',
      predicate: 'is_a',
      object_value: 'thing',
    },
  ],
  objects: [],
  fact_object_links: [],
  fact_fact_links: [],
  disambiguation_pending: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.listPredicates as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('DecideOverlay — checkbox-by-default landing (B-31)', () => {
  it('lands with every fact pre-accepted (checkbox on)', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    const cb1 = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    const cb2 = screen.getByTestId('fact-checkbox-fn-2') as HTMLInputElement;
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);
    const counter = screen.getByTestId('decision-counters');
    expect(counter).toHaveTextContent(/accepted:\s*2/);
    expect(counter).toHaveTextContent(/discarded:\s*0/);
  });

  it('Submit on landing accepts every fact (the 2-click normal path)', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByText('Submit decisions'));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    const call = (api.submitDecisions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const payload = call[2] as { decisions: Array<{ fact_uid: string; action: string }> };
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions).toContainEqual(expect.objectContaining({ fact_uid: 'fn-1', action: 'accept' }));
    expect(payload.decisions).toContainEqual(expect.objectContaining({ fact_uid: 'fn-2', action: 'accept' }));
  });

  it('Submit button is enabled on landing — no "Accept all" indirection', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    expect(screen.getByText('Submit decisions')).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /Accept all/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Review/i })).toBeNull();
  });
});

describe('DecideOverlay — uncheck flow (B-31)', () => {
  it('unchecking a fact moves it from accepted to discarded in the counter', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    const counter = screen.getByTestId('decision-counters');
    expect(counter).toHaveTextContent(/accepted:\s*1/);
    expect(counter).toHaveTextContent(/discarded:\s*1/);
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'discard');
  });

  it('Submit after unchecking one fact records accept + discard', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-2'));
    fireEvent.click(screen.getByText('Submit decisions'));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    const call = (api.submitDecisions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const payload = call[2] as { decisions: Array<{ fact_uid: string; action: string }> };
    expect(payload.decisions).toContainEqual(expect.objectContaining({ fact_uid: 'fn-1', action: 'accept' }));
    expect(payload.decisions).toContainEqual(expect.objectContaining({ fact_uid: 'fn-2', action: 'discard' }));
  });

  it('re-checking a discarded fact returns it to accept', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'discard');
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'accept');
  });
});

describe('DecideOverlay — Edit + Discard buttons (B-31)', () => {
  it('Edit button switches a fact into edit mode while keeping the checkbox on', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    const editButtons = screen.getAllByText('Edit');
    fireEvent.click(editButtons[0]!);
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'edit');
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    const counter = screen.getByTestId('decision-counters');
    expect(counter).toHaveTextContent(/edited:\s*1/);
  });

  it('Discard button has the same effect as unchecking', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    const discardButtons = screen.getAllByText('Discard');
    fireEvent.click(discardButtons[0]!);
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'discard');
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });
});

describe('DecideOverlay — submit success panel (B-37)', () => {
  it('replaces the review surface with the success panel after Submit', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    expect(screen.getByText('Submit decisions')).toBeInTheDocument();
    expect(screen.getByTestId('fact-card-fn-1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Submit decisions'));
    await waitFor(() =>
      expect(screen.queryByTestId('decisions-recorded-panel')).not.toBeNull(),
    );
    expect(screen.queryByTestId('fact-card-fn-1')).toBeNull();
    expect(screen.queryByTestId('fact-card-fn-2')).toBeNull();
    const back = screen.getByTestId('back-to-pending') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/pending');
  });

  it('success panel includes the counts of accepted / edited / discarded', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-2'));
    fireEvent.click(screen.getByText('Submit decisions'));
    await waitFor(() =>
      expect(screen.queryByTestId('decisions-recorded-panel')).not.toBeNull(),
    );
    const panel = screen.getByTestId('decisions-recorded-panel');
    expect(panel).toHaveTextContent(/1건 accept/);
    expect(panel).toHaveTextContent(/1건 discard/);
  });
});

describe('DecideOverlay — discard job button rename (spo-pending-ux)', () => {
  it('renders "이 추출 전체 폐기" button instead of "Discard job"', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    expect(screen.getByText('이 추출 전체 폐기')).toBeInTheDocument();
    expect(screen.queryByText('Discard job')).toBeNull();
  });

  it('clicking "이 추출 전체 폐기" calls discardJob API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByText('이 추출 전체 폐기'));
    await waitFor(() => expect(api.discardJob).toHaveBeenCalledWith('ks-1', 'job-xyz'));
  });
});
describe('DecideOverlay — decide-ux-fix #2: KR/EN toggle removed', () => {
  it('does not render a LangToggle group', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    expect(screen.queryByRole('group', { name: /Display language/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^KR$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^EN$/ })).toBeNull();
  });

  it('renders fact claims using the EN prefer-fallback', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    expect(screen.getByText('EN claim 1')).toBeInTheDocument();
    expect(screen.getByText('EN claim 2')).toBeInTheDocument();
  });
});

describe('DecideOverlay — discard race fix (feat/popup-cleanup-discard-sync)', () => {
  it('fires notifyStateChanged with discarded:true after discardJob resolves', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('lucid:state-changed', handler);
    try {
      render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
      fireEvent.click(screen.getByText('이 추출 전체 폐기'));
      await waitFor(() => expect(api.discardJob).toHaveBeenCalled());
      // 200ms delay before notify lands — give it time
      await new Promise((r) => setTimeout(r, 300));
      // fix/h1-state-sync-autorefresh: pick the FIRST event that
      // matches *this* job_id (not just by reason). Previously Submit
      // fired its notify synchronously and there was no risk of a
      // cross-test bleed; now Submit waits 200ms and a leftover Submit
      // timer from an earlier test in the same file could fire its
      // own decision-submitted event into this listener. Filter by
      // discarded:true so only the discard path matches.
      const discardEvent = events.find(
        (e) => {
          const detail = e.detail as { reason?: string; payload?: { discarded?: boolean } };
          return detail?.reason === 'decision-submitted'
            && detail?.payload?.discarded === true;
        },
      );
      expect(discardEvent).toBeDefined();
      const payload = (discardEvent!.detail as { payload?: { jobId: string; discarded: boolean } }).payload;
      expect(payload?.discarded).toBe(true);
      expect(payload?.jobId).toBe('job-xyz');
    } finally {
      window.removeEventListener('lucid:state-changed', handler);
    }
  });
});

describe('DecideOverlay — fix/decide-zero-fact-ux (0 fact 케이스)', () => {
  const emptyJob = {
    ...baseJob,
    facts: [],
  };

  it('renders the empty-extract panel instead of the raw fact list', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={emptyJob} />);
    const panel = screen.getByTestId('decide-empty-extract');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent(/이 기사에서 추출 가능한 사실이 없었습니다/);
    expect(panel).toHaveTextContent(/의견·해설 위주의 문장 구조/);
  });

  it('prominent 폐기 button is visible in the empty panel', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={emptyJob} />);
    const panel = screen.getByTestId('decide-empty-extract');
    expect(panel.querySelector('button')).not.toBeNull();
    expect(panel).toHaveTextContent('이 추출 전체 폐기');
  });

  it('does not render Submit decisions button when facts are empty', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={emptyJob} />);
    expect(screen.queryByText('Submit decisions')).toBeNull();
  });

  it('renders a back-to-pending link from the empty panel', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={emptyJob} />);
    const back = screen.getByTestId('empty-back-to-pending') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/pending');
  });
});

describe('DecideOverlay — submit fires notifyStateChanged (fix/h1-state-sync-autorefresh)', () => {
  it('fires decision-submitted notify after successful submit', async () => {
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('lucid:state-changed', handler);
    try {
      render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
      fireEvent.click(screen.getByText('Submit decisions'));
      await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
      // submit path now waits 200ms before notify (parity with discard)
      await new Promise((r) => setTimeout(r, 300));
      const submitEvent = events.find(
        (e) => (e.detail as { reason?: string })?.reason === 'decision-submitted',
      );
      expect(submitEvent).toBeDefined();
      const payload = (submitEvent!.detail as {
        payload?: { jobId: string; discarded?: boolean };
      }).payload;
      expect(payload?.jobId).toBe('job-xyz');
      // submit (not discard) — discarded field MUST NOT be true
      expect(payload?.discarded).not.toBe(true);
    } finally {
      window.removeEventListener('lucid:state-changed', handler);
    }
  });
});
