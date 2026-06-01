import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DecideOverlay } from '@/components/DecideOverlay';
import type { PendingJobDetail } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  acceptAll: vi.fn(async () => ({
    accepted_facts: ['fn-1', 'fn-2'],
    edited_facts: [],
    discarded_facts: [],
    created_objects: [],
    merged_objects: [],
    skipped_objects: [],
    validation_log_count: 1,
  })),
  discardJob: vi.fn(async () => ({
    accepted_facts: [],
    edited_facts: [],
    discarded_facts: ['fn-1', 'fn-2'],
    created_objects: [],
    merged_objects: [],
    skipped_objects: [],
    validation_log_count: 1,
  })),
  submitDecisions: vi.fn(async (_s: string, _j: string, payload: { decisions: Array<{ fact_uid: string; action: string }> }) => ({
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

const job: PendingJobDetail = {
  job_id: 'job-xyz',
  source_url: 'https://example.com/article',
  source_type: 'web_article',
  captured_at: new Date().toISOString(),
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

describe('DecideOverlay', () => {
  it('renders the Accept all tab by default', () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={job} />);
    expect(screen.getByText(/Accept all 2 facts/i)).toBeInTheDocument();
  });

  it('calls acceptAll when the Accept all button is clicked', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={job} />);
    fireEvent.click(screen.getByText(/Accept all 2 facts/i));
    await waitFor(() => expect(api.acceptAll).toHaveBeenCalledTimes(1));
  });

  it('submits per-card decisions in Review mode', async () => {
    render(<DecideOverlay spaceId="ks-1" jobId="job-xyz" initial={job} />);
    fireEvent.click(screen.getByText(/^Review$/));
    // Accept fn-1, Discard fn-2.
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
