/**
 * feat/ledger-view — LedgerView regression suite.
 *
 * Mirrors the RecallView test patterns: mock `@/lib/api`, render the
 * component with a stub spaceId, drive interactions via fireEvent /
 * waitFor. next/link is replaced with a plain anchor so tests can
 * assert on the href without exercising the router.
 *
 * Acceptance lock — at least 5 cases covering:
 *   - initial fetch → loading → render
 *   - empty state + /pending CTA
 *   - filter chip → refetch with factType
 *   - 더 보기 pagination → second fetch with offset
 *   - entity deep-link href targets /recall?q=<subject_label>
 *   - FactTypeBadge renders for claim facts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';

import type { LedgerItem, LedgerResponse } from '@/lib/types';

// next/link → plain anchor so href can be asserted in tests.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/api', () => ({ fetchLedger: vi.fn() }));

import * as api from '@/lib/api';
import { LedgerView } from '@/components/LedgerView';

function buildItem(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    fact_uid: 'fact-1',
    claim: '한국은행 기준금리는 3.0%였다.',
    claim_en: null,
    subject_uid: 'subj-1',
    subject_label: '한국은행',
    predicate: 'set_rate',
    predicate_label: '결정했다',
    object_value: '3.0%',
    object_label: null,
    source_uids: ['https://example.com/1'],
    validated_at: new Date().toISOString(),
    knowledge_space_id: 'ks-1',
    fact_type: 'action',
    speaker_label: null,
    speech_act: null,
    content_claim: null,
    metric: null,
    measurement_value: null,
    measurement_unit: null,
    as_of: null,
    ...overrides,
  };
}

function buildResponse(
  facts: LedgerItem[],
  overrides: Partial<LedgerResponse> = {},
): LedgerResponse {
  return {
    facts,
    total: facts.length,
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LedgerView', () => {
  it('renders loading then facts', async () => {
    const facts = [
      buildItem({ fact_uid: 'f-a', claim: 'fact A claim' }),
      buildItem({ fact_uid: 'f-b', claim: 'fact B claim' }),
      buildItem({ fact_uid: 'f-c', claim: 'fact C claim' }),
    ];
    (api.fetchLedger as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse(facts),
    );

    render(<LedgerView spaceId="ks-1" />);

    // Loading spinner is up during the initial fetch.
    expect(screen.queryByTestId('ledger-loading')).not.toBeNull();

    await waitFor(() =>
      expect(api.fetchLedger).toHaveBeenCalledWith('ks-1', {
        limit: 20,
        offset: 0,
        factType: null,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('fact A claim')).toBeInTheDocument();
      expect(screen.getByText('fact B claim')).toBeInTheDocument();
      expect(screen.getByText('fact C claim')).toBeInTheDocument();
    });
  });

  it('renders empty state when total is zero', async () => {
    (api.fetchLedger as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse([], { total: 0 }),
    );

    render(<LedgerView spaceId="ks-1" />);

    const empty = await screen.findByTestId('ledger-empty-state');
    expect(empty.textContent).toMatch(/아직 검증한 사실이 없습니다/);
    // CTA link to /pending.
    const cta = empty.querySelector('a[href="/pending"]');
    expect(cta).not.toBeNull();
  });

  it('filter chip click refetches with fact_type', async () => {
    (api.fetchLedger as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(buildResponse([buildItem()]))
      .mockResolvedValueOnce(
        buildResponse([buildItem({ fact_uid: 'claim-only', fact_type: 'claim' })]),
      );

    render(<LedgerView spaceId="ks-1" />);

    await waitFor(() => expect(api.fetchLedger).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('ledger-filter-chip-claim'));

    await waitFor(() => expect(api.fetchLedger).toHaveBeenCalledTimes(2));
    expect(api.fetchLedger).toHaveBeenLastCalledWith('ks-1', {
      limit: 20,
      offset: 0,
      factType: 'claim',
    });
  });

  it('"더 보기" pagination loads next page', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) =>
      buildItem({ fact_uid: `p1-${i}`, claim: `page1 fact ${i}` }),
    );
    const page2 = Array.from({ length: 15 }, (_, i) =>
      buildItem({ fact_uid: `p2-${i}`, claim: `page2 fact ${i}` }),
    );
    (api.fetchLedger as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(buildResponse(page1, { total: 35 }))
      .mockResolvedValueOnce(
        buildResponse(page2, { total: 35, offset: 20 }),
      );

    render(<LedgerView spaceId="ks-1" />);

    await screen.findByText('page1 fact 0');
    // Load more button should be visible since 20 < total (35).
    const more = await screen.findByTestId('ledger-load-more');
    fireEvent.click(more);

    await waitFor(() => expect(api.fetchLedger).toHaveBeenCalledTimes(2));
    expect(api.fetchLedger).toHaveBeenLastCalledWith('ks-1', {
      limit: 20,
      offset: 20,
      factType: null,
    });

    // Combined render — page1 + page2 facts present.
    await waitFor(() => {
      expect(screen.getByText('page1 fact 0')).toBeInTheDocument();
      expect(screen.getByText('page2 fact 0')).toBeInTheDocument();
    });
  });

  it('entity link in card targets recall with subject_label', async () => {
    const fact = buildItem({
      fact_uid: 'fact-x',
      subject_uid: 'subj-x',
      subject_label: 'SpaceX',
    });
    (api.fetchLedger as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse([fact]),
    );

    render(<LedgerView spaceId="ks-1" />);

    const link = await screen.findByTestId(
      'ledger-fact-fact-x-subject-link',
    );
    expect(link.getAttribute('href')).toBe('/recall?q=SpaceX');
  });

  it('shows FactTypeBadge for claim facts', async () => {
    const fact = buildItem({
      fact_uid: 'claim-fact',
      fact_type: 'claim',
      speaker_label: '국가데이터처',
      speech_act: '발표했다',
      content_claim: '4월 기준 증가율은 0.1%',
    });
    (api.fetchLedger as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse([fact]),
    );

    render(<LedgerView spaceId="ks-1" />);

    // FactTypeBadge inserts `fact-claim-badge-{uid}` for claim rows.
    const badge = await screen.findByTestId('fact-claim-badge-claim-fact');
    expect(badge.textContent).toBe('CLAIM');
  });

  it('fix/h1-state-sync-autorefresh — decision-submitted event triggers reload', async () => {
    const initial = [
      buildItem({ fact_uid: 'old-1', claim: 'old claim 1' }),
    ];
    const refreshed = [
      buildItem({ fact_uid: 'new-1', claim: 'new claim 1' }),
      buildItem({ fact_uid: 'old-1', claim: 'old claim 1' }),
    ];
    (api.fetchLedger as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(buildResponse(initial))
      .mockResolvedValueOnce(buildResponse(refreshed));

    render(<LedgerView spaceId="ks-1" />);

    await waitFor(() => {
      expect(screen.getByText('old claim 1')).toBeInTheDocument();
    });
    expect(api.fetchLedger).toHaveBeenCalledTimes(1);

    // Fire the same event DecideOverlay fires post-Submit.
    window.dispatchEvent(
      new CustomEvent('lucid:state-changed', {
        detail: { reason: 'decision-submitted', payload: { jobId: 'j-1' } },
      }),
    );

    // LedgerView should re-call fetchLedger and surface the new claim.
    await waitFor(() => expect(api.fetchLedger).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText('new claim 1')).toBeInTheDocument(),
    );
  });
});
