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
import { renderToString } from 'react-dom/server';

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

// B-61 — useAuthMe drives the personalised welcome line. Default to
// "no authenticated me" so existing tests keep their userName prop
// pinning and the welcome line does NOT appear.
const useAuthMeMock = vi.fn(() => ({ me: null, loading: false, error: null }));
vi.mock('@/lib/useAuthMe', () => ({
  useAuthMe: () => useAuthMeMock(),
}));

import { HomePage, greetingFor, selectViewState } from '@/components/HomePage';
import { LUCID_VERSION } from '@/lib/version';

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
  useAuthMeMock.mockReset();
  useAuthMeMock.mockReturnValue({ me: null, loading: false, error: null });
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

  // -------------------------------------------------------------------------
  // B-61 — personalised cold-start welcome line
  // -------------------------------------------------------------------------

  it('B-61 — welcome line renders when is_new_user=true + display_name set, above the 3-step card', () => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-1',
        email: 'alice@example.com',
        display_name: 'Alice',
        default_space_id: 's-1',
        is_new_user: true,
      },
      loading: false,
      error: null,
    });

    render(<HomePage userName="박기흥" />);

    const welcome = screen.getByTestId('home-welcome-line');
    expect(welcome).toBeInTheDocument();
    expect(welcome).toHaveTextContent('Alice');
    expect(welcome).toHaveTextContent(
      '환영합니다, Alice님. 첫 사실을 캡처하면 여기서 살아납니다.',
    );

    // The 3-step card is still rendered (step 1/2/3).
    const step1 = screen.getByTestId('home-empty-step-1');
    expect(step1).toBeInTheDocument();
    // The welcome line appears BEFORE the first cold-start step in DOM order.
    const empty = screen.getByTestId('home-empty');
    const order = Array.from(empty.querySelectorAll('[data-testid]'))
      .map((n) => n.getAttribute('data-testid'));
    const welcomeIdx = order.indexOf('home-welcome-line');
    const step1Idx = order.indexOf('home-empty-step-1');
    expect(welcomeIdx).toBeGreaterThanOrEqual(0);
    expect(step1Idx).toBeGreaterThanOrEqual(0);
    expect(welcomeIdx).toBeLessThan(step1Idx);
  });

  it('B-61 — welcome line is hidden when is_new_user=false (returning user)', () => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-2',
        email: 'returning@example.com',
        display_name: 'Bob',
        default_space_id: 's-2',
        is_new_user: false,
      },
      loading: false,
      error: null,
    });

    render(<HomePage userName="박기흥" />);

    expect(screen.queryByTestId('home-welcome-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-empty-step-1')).toBeInTheDocument();
  });

  it('B-61 — welcome line is hidden when there is no me (logged-out / no token)', () => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
    // default useAuthMe → { me: null }
    render(<HomePage userName="박기흥" />);

    expect(screen.queryByTestId('home-welcome-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-empty-step-1')).toBeInTheDocument();
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

  // ---------------------------------------------------------------------
  // feat/count-source-unification (2026-06-23): the ActiveBriefing copy
  // ("어제 캡처하신 N건이...") and the TodayBriefingCard's pending row
  // ("검증 대기 N건") MUST both surface the same number, because they
  // both flow from `brief.pending_validation`. The PO observed three
  // different numbers on the same screen — these tests pin that any
  // future refactor that introduces a divergent source breaks here.
  // ---------------------------------------------------------------------

  it('count-source-unification — briefing copy + card count read SAME pending_validation field', () => {
    const brief: HomeBrief = { ...POPULATED, pending_validation: 5 };
    useHomeBriefMock.mockReturnValue({ brief, pendingCount: 5 });

    render(<HomePage userName="박기흥" />);

    // The ActiveBriefing paragraph emphasises the number.
    expect(screen.getByTestId('home-briefing-pending')).toHaveTextContent(
      '5건',
    );
    // The TodayBriefingCard row emphasises the same number.
    expect(screen.getByTestId('home-briefing-pending-count')).toHaveTextContent(
      '5건',
    );
  });

  it('count-source-unification — HomePage calls useHomeBrief ONCE (no second fetch source)', () => {
    // If a refactor splits the badge fetch from the brief fetch, the
    // hook will be called multiple times from this component tree.
    // We pin one call so a regression that re-introduces the two-
    // source desync trips here.
    const brief: HomeBrief = { ...POPULATED, pending_validation: 5 };
    useHomeBriefMock.mockReset();
    useHomeBriefMock.mockReturnValue({ brief, pendingCount: 5 });

    render(<HomePage userName="박기흥" />);

    expect(useHomeBriefMock).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// feat/changelog-and-version-display (2026-06-23):
//
// PO established versioning discipline (v0.1.0 anchor before data-model
// overhaul). The home page should surface the current version in a small,
// subtle footer so the PO can confirm at-a-glance which dogfood round
// they are looking at. The constant lives in `lib/version.ts` and is
// the SINGLE SOURCE OF TRUTH — never read from package.json at runtime.
// ---------------------------------------------------------------------------

describe('LUCID_VERSION constant', () => {
  it('matches the semver-ish pre-alpha format 0.MINOR.PATCH', () => {
    // Pre-alpha 0.y.z — 0.MINOR = dogfood round unit, tag = PO graduation.
    expect(LUCID_VERSION).toMatch(/^0\.\d+\.\d+$/);
  });

  it('is currently pinned at 0.1.0 (the anchor before data-model overhaul)', () => {
    expect(LUCID_VERSION).toBe('0.1.0');
  });
});

describe('HomePage version footer', () => {
  beforeEach(() => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
  });

  it('renders the version footer on the cold-start (empty) arm', () => {
    render(<HomePage userName="박기흥" />);

    const footer = screen.getByTestId('home-version-footer');
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveTextContent(`Lucid v${LUCID_VERSION}`);
    expect(footer).toHaveTextContent('Lucid v0.1.0');
  });

  it('renders the version footer on the populated arm', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });

    render(<HomePage userName="박기흥" />);

    const footer = screen.getByTestId('home-version-footer');
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveTextContent('Lucid v0.1.0');
  });
});

// ---------------------------------------------------------------------------
// feat/home-greeting-hydration (2026-06-23):
//
// The time-of-day greeting branch (아침/오후/저녁) depends on the local TZ.
// When the Next.js server (UTC by default on hosted environments) renders
// SSR HTML, and the user's browser hydrates with a non-UTC clock, the two
// branches disagree → React emits a recoverable hydration mismatch warning
// targeting `GreetingH1` at HomePage.tsx:187.
//
// Contract: the FIRST paint (both server SSR and the pre-effect client
// render) MUST show a neutral, TZ-independent greeting. After mount, the
// useEffect computes the local-time greeting and the component re-renders.
// ---------------------------------------------------------------------------

describe('GreetingH1 hydration', () => {
  beforeEach(() => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
  });

  it('SSR (renderToString — no effects) renders neutral greeting "안녕하세요", not a TZ-dependent branch', () => {
    // renderToString never runs useEffect, so the output mirrors what
    // the Next.js server emits into the HTML the browser receives.
    const html = renderToString(<HomePage userName="박기흥" />);
    expect(html).toContain('안녕하세요');
    expect(html).toContain('박기흥');
    // None of the three time-branch literals leak into SSR markup.
    expect(html).not.toContain('좋은 아침입니다');
    expect(html).not.toContain('좋은 오후입니다');
    expect(html).not.toContain('좋은 저녁입니다');
  });

  it('first client paint shows neutral fallback, then re-renders with local-time greeting after mount', () => {
    // Pin the wall-clock to 15:00 local → "좋은 오후입니다".
    const fixed = new Date();
    fixed.setHours(15, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    try {
      // act() flushes the initial render AND post-render effects, so
      // by the time render() returns we already see the "after mount"
      // state. That's the same lifecycle the browser observes — by the
      // time the user looks at pixels, the effect has run and the
      // greeting matches local time.
      render(<HomePage userName="박기흥" />);

      const greeting = screen.getByTestId('home-greeting');
      expect(greeting).toHaveTextContent('좋은 오후입니다');
      expect(greeting).toHaveTextContent('박기흥');
      // Neutral fallback no longer present after the effect runs.
      expect(greeting.textContent).not.toContain('안녕하세요');
    } finally {
      vi.useRealTimers();
    }
  });

  it('local-time greeting branches correctly at morning / afternoon / evening boundaries', () => {
    const cases: Array<[number, string]> = [
      [7, '좋은 아침입니다'],
      [15, '좋은 오후입니다'],
      [21, '좋은 저녁입니다'],
    ];
    for (const [hour, expected] of cases) {
      const fixed = new Date();
      fixed.setHours(hour, 0, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(fixed);
      try {
        render(<HomePage userName="박기흥" />);
        expect(screen.getByTestId('home-greeting')).toHaveTextContent(
          expected,
        );
      } finally {
        vi.useRealTimers();
        cleanup();
      }
    }
  });
});
