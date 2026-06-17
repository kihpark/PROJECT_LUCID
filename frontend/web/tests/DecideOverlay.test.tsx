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
    // The pre-B-31 "Accept all N undecided" button is gone.
    expect(screen.queryByRole('button', { name: /Accept all/i })).toBeNull();
    // And no tabs.
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
