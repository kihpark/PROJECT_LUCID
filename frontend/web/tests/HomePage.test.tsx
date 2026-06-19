/**
 * B-59 — /home page test suite.
 *
 * Covers the three contracts the task pinned:
 *  - populated render (numbers visible + 오늘의 브리핑 card mounted)
 *  - cold-start when brief.is_empty=true (CTA + disabled recall + 3-step)
 *  - cold-start when useHomeBrief throws (brief==null) — fail-soft
 *  - recall input submit on populated → /recall?q=<encoded> (router.push)
 *  - top_cluster row hidden when linked_count == 0 (polish — cheap)
 *  - greetingFor() time-of-day branches (pure helper)
 *
 * Why mock at module boundaries: HomePage consumes `useHomeBrief()` and
 * `next/navigation`. We mock the hook directly so the component renders
 * synchronously without exercising the fail-soft fetch dance — the
 * fetch path is already covered by the AppShell suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import type { HomeBrief } from '@/lib/types';

// next/link — render as anchor so test queries can see href.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
}));

// next/navigation — pin useRouter so populated submit can be asserted.
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// useHomeBrief — drive the hook return shape per-test.
const useHomeBriefMock = vi.fn();
vi.mock('@/lib/useHomeBrief', () => ({
  useHomeBrief: () => useHomeBriefMock(),
}));

import { HomePage, greetingFor, selectViewState } from '@/components/HomePage';

const POPULATED: HomeBrief = {
  totals: {
    facts: 247,
    entities: 89,
    sources: 34,
    this_week_validated: 12,
  },
  pending_validation: 3,
  recent_validated: [],
  top_cluster: {
    entity_uid: 'obj-spacex',
    entity_name: 'SpaceX',
    linked_count: 8,
  },
  is_empty: false,
};

const EMPTY: HomeBrief = {
  totals: { facts: 0, entities: 0, sources: 0, this_week_validated: 0 },
  pending_validation: 0,
  recent_validated: [],
  top_cluster: null,
  is_empty: true,
};

beforeEach(() => {
  pushMock.mockReset();
  useHomeBriefMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('HomePage', () => {
  it('renders populated home with brief numbers when useHomeBrief returns is_empty=false', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });

    render(<HomePage userName="박기흥" />);

    // Populated arm mounted, not cold-start.
    expect(screen.getByTestId('home-populated')).toBeInTheDocument();
    expect(screen.queryByTestId('home-empty')).not.toBeInTheDocument();

    // Status label switches to "대기 중".
    expect(screen.getByTestId('home-status-label')).toHaveTextContent(
      'LUCID · 대기 중',
    );

    // Briefing paragraph emphasises facts + pending counts.
    expect(screen.getByTestId('home-briefing-facts')).toHaveTextContent('247개');
    expect(screen.getByTestId('home-briefing-pending')).toHaveTextContent('3건');

    // 오늘의 브리핑 card with all three rows visible.
    const card = screen.getByTestId('home-briefing-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId('home-briefing-row-pending')).toBeInTheDocument();
    expect(screen.getByTestId('home-briefing-pending-count')).toHaveTextContent(
      '3건',
    );
    expect(screen.getByTestId('home-briefing-row-this-week')).toBeInTheDocument();
    expect(
      screen.getByTestId('home-briefing-this-week-count'),
    ).toHaveTextContent('+12개');
    expect(screen.getByTestId('home-briefing-cluster-name')).toHaveTextContent(
      'SpaceX',
    );

    // 지금 검증 CTA points at /pending.
    const cta = screen.getByTestId('home-briefing-pending-cta');
    expect(cta).toHaveAttribute('href', '/pending');

    // Quick stats bar shows all four numbers.
    expect(screen.getByTestId('home-stat-facts')).toHaveTextContent('247');
    expect(screen.getByTestId('home-stat-entities')).toHaveTextContent('89');
    expect(screen.getByTestId('home-stat-sources')).toHaveTextContent('34');
    expect(screen.getByTestId('home-stat-this-week')).toHaveTextContent('+12');
  });

  it('renders cold-start when brief.is_empty=true', () => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });

    render(<HomePage userName="박기흥" />);

    expect(screen.getByTestId('home-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('home-populated')).not.toBeInTheDocument();

    // Status label switches to "첫 사실을 기다리는 중".
    expect(screen.getByTestId('home-status-label')).toHaveTextContent(
      'LUCID · 첫 사실을 기다리는 중',
    );

    // Cold-start CTA.
    const cta = screen.getByTestId('home-empty-cta');
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveTextContent('첫 사실 캡처하기');

    // Disabled recall input.
    const input = screen.getByTestId(
      'home-empty-recall-input',
    ) as HTMLInputElement;
    expect(input).toBeDisabled();
    expect(input.placeholder).toContain('검증된 사실이 쌓이면');

    // 3-step guide.
    expect(screen.getByTestId('home-empty-step-1')).toBeInTheDocument();
    expect(screen.getByTestId('home-empty-step-2')).toBeInTheDocument();
    expect(screen.getByTestId('home-empty-step-3')).toBeInTheDocument();

    // No active recall form in cold-start.
    expect(screen.queryByTestId('home-recall-form')).not.toBeInTheDocument();
  });

  it('renders cold-start when useHomeBrief returns brief=null (fail-soft)', () => {
    // Simulate the fail-soft branch: hook caught a fetch error and
    // exposed { brief: null }. HomePage must NOT crash and must render
    // the cold-start surface, not a blank screen.
    useHomeBriefMock.mockReturnValue({ brief: null, pendingCount: 0 });

    render(<HomePage userName="박기흥" />);

    expect(screen.getByTestId('home-empty')).toBeInTheDocument();
    expect(screen.getByTestId('home-empty-cta')).toBeInTheDocument();
    expect(
      screen.getByTestId('home-empty-recall-input'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('home-empty-step-1')).toBeInTheDocument();

    // Greeting still renders (shared between arms).
    expect(screen.getByTestId('home-greeting')).toHaveTextContent('박기흥');
  });

  it('recall input on populated submits to /recall?q=<encoded>', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });

    render(<HomePage userName="박기흥" />);

    const form = screen.getByTestId('home-recall-form');
    const input = screen.getByTestId(
      'home-recall-input',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '한국은행 기준금리' } });
    fireEvent.submit(form);

    expect(pushMock).toHaveBeenCalledTimes(1);
    // Encoded Korean: spaces become %20, hangul → %xx triplets.
    const target = pushMock.mock.calls[0]?.[0] as string;
    expect(target).toMatch(/^\/recall\?q=/);
    expect(decodeURIComponent(target.replace('/recall?q=', ''))).toBe(
      '한국은행 기준금리',
    );
  });

  it('does not navigate when recall input is empty/whitespace', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });

    render(<HomePage userName="박기흥" />);

    const form = screen.getByTestId('home-recall-form');
    const input = screen.getByTestId(
      'home-recall-input',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(form);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('hides the cluster row when top_cluster.linked_count == 0', () => {
    const noCluster: HomeBrief = {
      ...POPULATED,
      top_cluster: { entity_uid: null, entity_name: null, linked_count: 0 },
    };
    useHomeBriefMock.mockReturnValue({ brief: noCluster, pendingCount: 3 });

    render(<HomePage userName="박기흥" />);

    expect(screen.getByTestId('home-briefing-row-pending')).toBeInTheDocument();
    expect(
      screen.getByTestId('home-briefing-row-this-week'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('home-briefing-row-cluster'),
    ).not.toBeInTheDocument();
  });

  it('briefing copy collapses pending phrase when pending_validation == 0', () => {
    const zeroPending: HomeBrief = { ...POPULATED, pending_validation: 0 };
    useHomeBriefMock.mockReturnValue({ brief: zeroPending, pendingCount: 0 });

    render(<HomePage userName="박기흥" />);

    expect(
      screen.getByTestId('home-briefing-no-pending'),
    ).toHaveTextContent('검증 대기는 없습니다.');
    expect(screen.queryByTestId('home-briefing-pending')).not.toBeInTheDocument();
  });
});

describe('greetingFor', () => {
  it('returns 좋은 아침입니다 for morning hours (05–11)', () => {
    expect(greetingFor(5)).toBe('좋은 아침입니다');
    expect(greetingFor(7)).toBe('좋은 아침입니다');
    expect(greetingFor(11)).toBe('좋은 아침입니다');
  });

  it('returns 좋은 오후입니다 for afternoon hours (12–17)', () => {
    expect(greetingFor(12)).toBe('좋은 오후입니다');
    expect(greetingFor(15)).toBe('좋은 오후입니다');
    expect(greetingFor(17)).toBe('좋은 오후입니다');
  });

  it('returns 좋은 저녁입니다 for evening + late hours (18–04)', () => {
    expect(greetingFor(18)).toBe('좋은 저녁입니다');
    expect(greetingFor(23)).toBe('좋은 저녁입니다');
    expect(greetingFor(0)).toBe('좋은 저녁입니다');
    expect(greetingFor(4)).toBe('좋은 저녁입니다');
  });
});

describe('selectViewState', () => {
  it('returns "empty" when brief is null (fail-soft)', () => {
    expect(selectViewState(null)).toBe('empty');
  });

  it('returns "empty" when brief.is_empty is true', () => {
    expect(selectViewState(EMPTY)).toBe('empty');
  });

  it('returns "populated" when brief has facts', () => {
    expect(selectViewState(POPULATED)).toBe('populated');
  });
});
