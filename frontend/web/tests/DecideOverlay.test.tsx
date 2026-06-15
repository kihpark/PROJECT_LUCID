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
  captured_at: new Date('2026-06-15T00:00:00Z').toISOString(),
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

describe('DecideOverlay — default landing (B-28 D-1)', () => {
  it('lands on the Review tab by default', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    // FactCard renders only on Review.
    expect(screen.getByTestId('fact-card-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-card-fn-2')).toBeInTheDocument();
    // The Review tab is the active aria-selected one.
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('initial counter shows all facts as undecided', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    const counter = screen.getByTestId('decision-counters');
    expect(counter).toHaveTextContent(/accepted:\s*0/);
    expect(counter).toHaveTextContent(/edited:\s*0/);
    expect(counter).toHaveTextContent(/discarded:\s*0/);
    expect(counter).toHaveTextContent(/undecided:\s*2/);
  });
});

describe('DecideOverlay — Submit per-card decisions (regression)', () => {
  it('submits the per-card decisions in Review mode', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getAllByText('Accept')[0]!);
    fireEvent.click(screen.getAllByText('Discard')[1]!);
    fireEvent.click(screen.getByText('Submit decisions'));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    const call = (api.submitDecisions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const payload = call[2] as {
      decisions: Array<{ fact_uid: string; action: string }>;
    };
    expect(payload.decisions).toContainEqual(
      expect.objectContaining({ fact_uid: 'fn-1', action: 'accept' }),
    );
    expect(payload.decisions).toContainEqual(
      expect.objectContaining({ fact_uid: 'fn-2', action: 'discard' }),
    );
  });
});

describe('DecideOverlay — Undo restores undecided (B-28 D-2)', () => {
  it('Undo button reverts an accepted fact to undecided', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    const counter = screen.getByTestId('decision-counters');
    // Accept fn-1
    fireEvent.click(screen.getAllByText('Accept')[0]!);
    expect(counter).toHaveTextContent(/accepted:\s*1/);
    expect(counter).toHaveTextContent(/undecided:\s*1/);
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'accept');
    // Undo
    fireEvent.click(screen.getAllByLabelText('Undo this decision')[0]!);
    expect(counter).toHaveTextContent(/accepted:\s*0/);
    expect(counter).toHaveTextContent(/undecided:\s*2/);
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'undecided');
  });

  it('Undo is disabled when fact is undecided', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    const undoButtons = screen.getAllByLabelText('Undo this decision');
    expect(undoButtons[0]).toBeDisabled();
    expect(undoButtons[1]).toBeDisabled();
  });

  it('Submit after Undo omits the un-decided fact from the payload', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getAllByText('Accept')[0]!);
    fireEvent.click(screen.getAllByText('Discard')[1]!);
    // Now undo fn-1
    fireEvent.click(screen.getAllByLabelText('Undo this decision')[0]!);
    fireEvent.click(screen.getByText('Submit decisions'));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    const call = (api.submitDecisions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const payload = call[2] as {
      decisions: Array<{ fact_uid: string; action: string }>;
    };
    expect(payload.decisions).toHaveLength(1);
    expect(payload.decisions[0]).toEqual(
      expect.objectContaining({ fact_uid: 'fn-2', action: 'discard' }),
    );
  });
});

describe('DecideOverlay — Accept all transitions + submits (B-28 D-3)', () => {
  it('Accept-all button on accept_all tab is disabled when no undecided facts', () => {
    const jobAllDecided: PendingJobDetail = { ...baseJob, facts: [] };
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={jobAllDecided} />);
    fireEvent.click(screen.getByRole('tab', { name: /Accept all/i }));
    const btn = screen.getByRole('button', { name: /Accept all 0 undecided/i });
    expect(btn).toBeDisabled();
  });

  it('Accept-all transitions every undecided fact to accept then submits', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getByRole('tab', { name: /Accept all/i }));
    fireEvent.click(screen.getByRole('button', { name: /Accept all 2 undecided/i }));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    // Backend's acceptAll endpoint should NOT be hit — D-3 routes the
    // bulk action through the unified submitDecisions path so Review
    // and Accept-all stay in sync.
    expect(api.acceptAll).not.toHaveBeenCalled();
    const call = (api.submitDecisions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const payload = call[2] as {
      decisions: Array<{ fact_uid: string; action: string }>;
    };
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions).toContainEqual(
      expect.objectContaining({ fact_uid: 'fn-1', action: 'accept' }),
    );
    expect(payload.decisions).toContainEqual(
      expect.objectContaining({ fact_uid: 'fn-2', action: 'accept' }),
    );
  });
});

describe('DecideOverlay — Review and Accept-all share state (B-28 D-4)', () => {
  it('discard on Review tab is preserved when Accept-all runs', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    // Discard fn-1 on Review tab
    fireEvent.click(screen.getAllByText('Discard')[0]!);
    // Switch to Accept-all
    fireEvent.click(screen.getByRole('tab', { name: /Accept all/i }));
    // Accept-all should now show 1 undecided (fn-2), and fn-1's state
    // should appear in the read-only list as 'discard'.
    expect(screen.getByTestId('accept-all-row-fn-1')).toHaveTextContent('[discard]');
    expect(screen.getByTestId('accept-all-row-fn-2')).toHaveTextContent('[undecided]');
    fireEvent.click(screen.getByRole('button', { name: /Accept all 1 undecided/i }));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    const call = (api.submitDecisions as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const payload = call[2] as {
      decisions: Array<{ fact_uid: string; action: string }>;
    };
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions).toContainEqual(
      expect.objectContaining({ fact_uid: 'fn-1', action: 'discard' }),
    );
    expect(payload.decisions).toContainEqual(
      expect.objectContaining({ fact_uid: 'fn-2', action: 'accept' }),
    );
  });

  it('Accept-all rendered state is reflected when switching back to Review', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    // Edit fn-1 on Review
    fireEvent.click(screen.getAllByText('Edit')[0]!);
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'edit');
    // Switch to Accept-all, accept the remaining undecided fn-2
    fireEvent.click(screen.getByRole('tab', { name: /Accept all/i }));
    fireEvent.click(screen.getByRole('button', { name: /Accept all 1 undecided/i }));
    await waitFor(() => expect(api.submitDecisions).toHaveBeenCalledTimes(1));
    // Switch back to Review — fn-1 still 'edit', fn-2 now 'accept'
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'edit');
    expect(screen.getByTestId('fact-card-fn-2')).toHaveAttribute('data-state', 'accept');
  });
});

describe('DecideOverlay — counters track shared state', () => {
  it('counters update across tab switches', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={baseJob} />);
    fireEvent.click(screen.getAllByText('Accept')[0]!);
    fireEvent.click(screen.getAllByText('Discard')[1]!);
    fireEvent.click(screen.getByRole('tab', { name: /Accept all/i }));
    const counter = screen.getByTestId('decision-counters');
    expect(counter).toHaveTextContent(/accepted:\s*1/);
    expect(counter).toHaveTextContent(/discarded:\s*1/);
    expect(counter).toHaveTextContent(/undecided:\s*0/);
  });
});
