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
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

// feat/hearth-oracle-merge — ORACLE engine is now invoked inline from
// HomePage. We mock postAssistantBrief so submission asserts can pin
// the call shape without exercising the real fetch path. The
// AssistantView module-level test pins the engine semantics.
const postAssistantBriefMock = vi.fn();
vi.mock('@/lib/api', () => ({
  postAssistantBrief: (...args: unknown[]) => postAssistantBriefMock(...args),
}));

import {
  HomePage,
  greetingFor,
  selectViewState,
  clusterFocusHref,
} from '@/components/HomePage';
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
  postAssistantBriefMock.mockReset();
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

    // feat/hearth-oracle-merge — "LUCID · 대기 중" status label
    // replaced with the fixed "BE LUCID." brand line.
    expect(screen.getByTestId('home-brand-line')).toHaveTextContent('BE LUCID.');
    expect(screen.queryByTestId('home-status-label')).not.toBeInTheDocument();
    // The long briefing paragraph ("지난 검증 이후 N개의 사실이…") is removed;
    // the same numbers stay in Quick Stats + 오늘의 브리핑 card.
    expect(screen.queryByTestId('home-briefing-facts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-briefing-pending')).not.toBeInTheDocument();

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

    // feat/hearth-oracle-merge — "BE LUCID." brand line appears in
    // both arms; the time-of-day status label is removed.
    expect(screen.getByTestId('home-brand-line')).toHaveTextContent('BE LUCID.');
    expect(screen.queryByTestId('home-status-label')).not.toBeInTheDocument();

    // Cold-start CTA.
    // REQ-014-A (PO 2026-07-02): 이전 "첫 사실 캡처하기 →" → "확장 설치하기 →".
    // 눌러도 목적이 명확하지 않다는 PO 피드백으로 확장 설치 modal 을 여는
    // 버튼으로 재설계.
    const cta = screen.getByTestId('home-empty-cta');
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveTextContent('확장 설치하기');

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

  it('feat/hearth-oracle-merge — recall input submit drives inline ORACLE Q&A, NOT a /recall navigation', async () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-1',
        email: 'kihpark85@example.com',
        display_name: '박기흥',
        default_space_id: 'ks-1',
        is_new_user: false,
      },
      loading: false,
      error: null,
    });
    postAssistantBriefMock.mockResolvedValue({
      grounded: true,
      verified: [
        {
          fact_uid: 'fn-1',
          subject: '한국은행',
          predicate_label: '기준금리',
          object: '3.5%',
          sources: ['src-1'],
        },
      ],
      inference: '한국은행 기준금리는 3.5%입니다.',
    });

    render(<HomePage userName="박기흥" />);

    const form = screen.getByTestId('home-recall-form');
    const input = screen.getByTestId(
      'home-recall-input',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '한국은행 기준금리' } });
    fireEvent.submit(form);

    // The ORACLE engine is called with the query + active space id.
    await waitFor(() => {
      expect(postAssistantBriefMock).toHaveBeenCalledTimes(1);
      expect(postAssistantBriefMock).toHaveBeenCalledWith(
        '한국은행 기준금리',
        'ks-1',
      );
    });
    // Router.push is NOT invoked — Q&A is inline, the user stays on /home.
    expect(pushMock).not.toHaveBeenCalled();

    // Verified + inference cards render inline, below the input.
    await waitFor(() => {
      expect(screen.getByTestId('assistant-result-inline')).toBeInTheDocument();
    });
    expect(screen.getByTestId('inference-card')).toHaveTextContent(
      '한국은행 기준금리는 3.5%입니다.',
    );
    expect(screen.getByTestId('verified-fact-card')).toBeInTheDocument();
    expect(screen.getByTestId('verified-badge')).toHaveTextContent('검증됨');
    expect(screen.getByTestId('inference-label')).toHaveTextContent('미보증');
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

  it('feat/hearth-oracle-merge — long briefing paragraph removed regardless of pending count', () => {
    // The old "지난 검증 이후 N개의 사실이…" paragraph was deleted by
    // H-3. The home-briefing-no-pending / -facts / -pending testids
    // belonged to that paragraph and must NOT appear in either branch
    // (pending == 0 or pending > 0). The same numbers stay reachable
    // via the card row + Quick Stats.
    const zeroPending: HomeBrief = { ...POPULATED, pending_validation: 0 };
    useHomeBriefMock.mockReturnValue({ brief: zeroPending, pendingCount: 0 });

    render(<HomePage userName="박기흥" />);

    expect(
      screen.queryByTestId('home-briefing-no-pending'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-briefing-pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-briefing-facts')).not.toBeInTheDocument();
    // The card-row count still surfaces the number (0건).
    expect(screen.getByTestId('home-briefing-pending-count')).toHaveTextContent(
      '0건',
    );
  });

  // ---------------------------------------------------------------------
  // feat/count-source-unification (2026-06-23): the ActiveBriefing copy
  // ("어제 캡처하신 N건이...") and the TodayBriefingCard's pending row
  // ("검증 대기 N건") MUST both surface the same number, because they
  // both flow from `brief.pending_validation`. The PO observed three
  // different numbers on the same screen — these tests pin that any
  // future refactor that introduces a divergent source breaks here.
  // ---------------------------------------------------------------------

  it('count-source-unification — pending count read from single source (brief.pending_validation) after H-3 paragraph removal', () => {
    // feat/hearth-oracle-merge: the long briefing paragraph (the second
    // surface that previously read pending_validation) is gone, so the
    // 검증 대기 number now flows from exactly one place: the card row.
    // This is even tighter than the original count-source-unification
    // contract — there is no second surface to drift against.
    const brief: HomeBrief = { ...POPULATED, pending_validation: 5 };
    useHomeBriefMock.mockReturnValue({ brief, pendingCount: 5 });

    render(<HomePage userName="박기흥" />);

    // The TodayBriefingCard row emphasises the number.
    expect(screen.getByTestId('home-briefing-pending-count')).toHaveTextContent(
      '5건',
    );
    // The old paragraph surface is gone.
    expect(screen.queryByTestId('home-briefing-pending')).not.toBeInTheDocument();
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

  // -------------------------------------------------------------------------
  // feat/hearth-oracle-merge — H-1 through H-5
  // -------------------------------------------------------------------------

  it('H-2 — sphere mounts with idle state by default (Jarvis-style entry hub)', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);
    const sphere = screen.getByTestId('home-sphere');
    expect(sphere).toBeInTheDocument();
    expect(sphere.getAttribute('data-sphere-state')).toBe('idle');
  });

  it('H-2 — typing in the input flips sphere to listening state', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);

    const input = screen.getByTestId('home-recall-input') as HTMLInputElement;
    fireEvent.focus(input);
    expect(screen.getByTestId('home-sphere').getAttribute('data-sphere-state')).toBe('listening');

    fireEvent.change(input, { target: { value: '한국은행' } });
    expect(screen.getByTestId('home-sphere').getAttribute('data-sphere-state')).toBe('listening');
  });

  it('H-2 — submitting the query drives sphere through thinking → speaking', async () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-1',
        email: 'a@b.c',
        display_name: '박',
        default_space_id: 'sp-1',
        is_new_user: false,
      },
      loading: false,
      error: null,
    });
    let resolveBrief!: (v: unknown) => void;
    postAssistantBriefMock.mockImplementation(
      () => new Promise((res) => { resolveBrief = res; }),
    );

    render(<HomePage userName="박기흥" />);
    const input = screen.getByTestId('home-recall-input') as HTMLInputElement;
    const form = screen.getByTestId('home-recall-form');
    fireEvent.change(input, { target: { value: 'Q' } });
    fireEvent.submit(form);

    // While the promise is in flight → thinking.
    await waitFor(() => {
      expect(screen.getByTestId('home-sphere').getAttribute('data-sphere-state')).toBe('thinking');
    });

    // Resolve the promise → component bumps state to speaking.
    resolveBrief({ grounded: true, verified: [], inference: 'answer' });

    await waitFor(() => {
      expect(screen.getByTestId('home-sphere').getAttribute('data-sphere-state')).toBe('speaking');
    });
  });

  it('H-3 — BE LUCID. brand line is fixed (visible in BOTH populated + empty)', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);
    expect(screen.getByTestId('home-brand-line')).toHaveTextContent('BE LUCID.');
    expect(screen.queryByTestId('home-status-label')).not.toBeInTheDocument();
    cleanup();

    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
    render(<HomePage userName="박기흥" />);
    expect(screen.getByTestId('home-brand-line')).toHaveTextContent('BE LUCID.');
    expect(screen.queryByTestId('home-status-label')).not.toBeInTheDocument();
  });

  it('H-3 — greeting reads <인사>, <이름>님. and is sized larger than the brand line', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    // Pin the clock to evening so the test is deterministic.
    const fixed = new Date();
    fixed.setHours(20, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    try {
      render(<HomePage userName="박기흥" />);
      const greeting = screen.getByTestId('home-greeting');
      const brand = screen.getByTestId('home-brand-line');
      expect(greeting).toHaveTextContent('좋은 저녁입니다, 박기흥님.');
      // Visual hierarchy: greeting > brand line.
      const greetingPx = parseInt(
        (greeting as HTMLElement).style.fontSize || '0',
        10,
      );
      const brandPx = parseInt(
        (brand as HTMLElement).style.fontSize || '0',
        10,
      );
      expect(greetingPx).toBeGreaterThan(brandPx);
    } finally {
      vi.useRealTimers();
    }
  });

  it('H-4 — 기록 보기 → link points at /ledger (was /recall)', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);
    const cta = screen.getByTestId('home-briefing-this-week-cta');
    expect(cta).toHaveAttribute('href', '/ledger');
  });

  it('H-5 — 살펴보기 → link points at /stellar?cluster=<entity_uid> (focuses cluster)', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);
    const cta = screen.getByTestId('home-briefing-cluster-cta');
    const href = cta.getAttribute('href') ?? '';
    expect(href).toMatch(/^\/stellar\?cluster=/);
    // POPULATED.top_cluster.entity_uid is 'obj-spacex'.
    expect(href).toBe('/stellar?cluster=obj-spacex');
  });

  it('H-2 — 살펴보기 → falls back to plain /stellar when entity_uid is missing (most_active sentinel removed)', () => {
    // fix/h2-stellar-cluster-focus-in-real: the `most_active` sentinel
    // path is intentionally retired. When entity_uid is null we route
    // to plain `/stellar` and let the user explore the real graph
    // themselves (STELLAR default = real, so the entity universe loads
    // immediately).
    const briefNoUid: HomeBrief = {
      ...POPULATED,
      top_cluster: {
        entity_uid: null,
        entity_name: 'NoUidCluster',
        linked_count: 4,
      },
    };
    useHomeBriefMock.mockReturnValue({ brief: briefNoUid, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);
    const cta = screen.getByTestId('home-briefing-cluster-cta');
    expect(cta).toHaveAttribute('href', '/stellar');
  });

  it('H-1 — empty input submit does not fire the ORACLE engine (no spam on Enter with empty box)', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    useAuthMeMock.mockReturnValue({
      me: {
        user_id: 'u-1',
        email: 'a@b.c',
        display_name: '박',
        default_space_id: 'sp-1',
        is_new_user: false,
      },
      loading: false,
      error: null,
    });
    render(<HomePage userName="박기흥" />);
    const form = screen.getByTestId('home-recall-form');
    fireEvent.submit(form);
    expect(postAssistantBriefMock).not.toHaveBeenCalled();
    // No inline result section either.
    expect(screen.queryByTestId('assistant-result-inline')).not.toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// fix/h2-stellar-cluster-focus-in-real (2026-06-26) — clusterFocusHref
// pure helper.
//
// PO 의뢰서 H-2: cluster focus 재도입 (entity_uid → /stellar?cluster=<uid>)
// 위에 d017a3a 의 most_active fallback 제거 (null cluster → 단순 /stellar).
// 6-path resolver 가 real 모드에서 subject_uid 매칭으로 spine fact 를 골라
// focus 한다 — 이 helper 는 그 chain 의 첫 번째 link 만 담당.
// ---------------------------------------------------------------------------

describe('clusterFocusHref (H-2 cluster focus link)', () => {
  it('returns /stellar?cluster=<entity_uid> when both entity_uid and linked_count are set', () => {
    expect(
      clusterFocusHref({ entity_uid: 'obj-spacex', linked_count: 8 }),
    ).toBe('/stellar?cluster=obj-spacex');
  });

  it('URL-encodes the entity_uid (safety for arbitrary uid shapes)', () => {
    expect(
      clusterFocusHref({
        entity_uid: '8e68baf5-97b1-4833-9604-a6b5dd99ec7b',
        linked_count: 12,
      }),
    ).toBe('/stellar?cluster=8e68baf5-97b1-4833-9604-a6b5dd99ec7b');
  });

  it('falls back to plain /stellar when cluster is null (most_active sentinel removed)', () => {
    expect(clusterFocusHref(null)).toBe('/stellar');
  });

  it('falls back to plain /stellar when entity_uid is null', () => {
    expect(
      clusterFocusHref({ entity_uid: null, linked_count: 5 }),
    ).toBe('/stellar');
  });

  it('falls back to plain /stellar when linked_count is 0 (no actual links)', () => {
    expect(
      clusterFocusHref({ entity_uid: 'abc', linked_count: 0 }),
    ).toBe('/stellar');
  });

  it('falls back to plain /stellar when both entity_uid is null and linked_count is 0', () => {
    expect(
      clusterFocusHref({ entity_uid: null, linked_count: 0 }),
    ).toBe('/stellar');
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

// REQ-014-A (PO 2026-07-02): home-version-footer 제거 (AppShell footer 만 유지)
// → 이전에는 홈 페이지에서 "Lucid v0.1.0" 이 두 번 반복 노출됨. 진짜 소스는
// AppShell 의 app-shell-version-footer 뿐. 아래 describe 는 REGRESSION GUARD
// 로 남겨 두어 home-version-footer 가 다시 부활하지 않는지만 확인한다.
describe('HomePage version footer removed (REQ-014-A regression guard)', () => {
  beforeEach(() => {
    useHomeBriefMock.mockReturnValue({ brief: EMPTY, pendingCount: 0 });
  });

  it('cold-start arm: no home-version-footer inside HomePage body', () => {
    render(<HomePage userName="박기흥" />);
    expect(screen.queryByTestId('home-version-footer')).not.toBeInTheDocument();
  });

  it('populated arm: no home-version-footer inside HomePage body', () => {
    useHomeBriefMock.mockReturnValue({ brief: POPULATED, pendingCount: 3 });
    render(<HomePage userName="박기흥" />);
    expect(screen.queryByTestId('home-version-footer')).not.toBeInTheDocument();
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
