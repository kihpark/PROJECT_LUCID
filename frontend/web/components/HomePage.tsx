/**
 * B-59 — Home (/home) two-state surface.
 *
 * feat/hearth-oracle-merge (2026-06-24):
 *   - ORACLE absorbed: the home search bar now drives the M4a Q&A engine
 *     inline. Verified vs. inference blocks render below the input.
 *   - HEARTH sphere: static teal orb replaced with a particle-ring
 *     animation (4 states: idle / listening / thinking / speaking).
 *   - Headline: "LUCID · 대기 중" → "BE LUCID." brand line above greeting.
 *     The long "지난 검증 이후 N개의 사실이…" briefing paragraph is removed
 *     (the same numbers stay in the Quick Stats bar + 오늘의 브리핑 card).
 *   - "기록 보기" → /ledger. "살펴보기" → /stellar?cluster=<entity_uid>.
 *
 * Implements the "AI 비서 홈" handoff from the design README:
 *
 *   - `populated` (Components 2–9): orb + greeting + recall + 오늘의 브리핑.
 *   - `empty`     (Components E1–E4): orb + greeting + cold-start CTA.
 *   - `unknown`   (reserved): the structure switches on a `HomeViewState`
 *     enum so a follow-up ticket can slot the "不知" state in.
 *
 * Fail-soft contract: when `useHomeBrief()` cannot load (B-55 not wired,
 * 401, network error), `brief` is `null`. We treat that as `empty`.
 *
 * The shared shell (header + nav + profile) comes from `app/layout.tsx`
 * (AppShell, B-57). This component is the body only.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHomeBrief } from '@/lib/useHomeBrief';
import { useAuthMe } from '@/lib/useAuthMe';
// REQ-014-A (PO 2026-07-02): LUCID_VERSION removed — home-version-footer
// deleted; the AppShell footer is now the single source of the version chip.
import type { HomeBrief } from '@/lib/types';
import type { MeResponse } from '@/lib/api';
import {
  AssistantQuery,
  type AssistantQueryHandle,
} from './AssistantQuery';
/**
 * ★ REQ-007-v1 (2026-06-30) — SphereAnimation → HearthSphere 입자 코어 교체.
 * 기존 4 상태 sphere 코드 제거 (중복 0 — PO 직접 지시).
 *
 * SphereState 별칭은 호출부 광범위 호환을 위해 유지.
 */
import {
  HearthSphere,
  type HearthSphereState,
} from './HearthSphere';

export type SphereState = HearthSphereState;

const ACCENT = '#3fe0c6';
const BG = '#06080b';
const CARD_BG = 'rgba(13,20,23,0.45)';
const CARD_BORDER = '#16211f';
const ROW_BORDER = '#131c1d';
const INPUT_BORDER = '#1d2b2f';
const TEXT_H1 = '#f1f6f7';
const TEXT_BODY = '#dbe6e7';
const TEXT_SECONDARY = '#9db0b5';
const TEXT_DIM = '#647479';
const TEXT_DIMMER = '#56686d';
const TEXT_DIMMEST = '#4d5b5f';
const TEXT_TINY = '#3a474b';
const TEXT_LABEL = '#bccacd';

export type HomeViewState = 'populated' | 'empty' | 'unknown';

// ---------------------------------------------------------------------------
// Small pure helpers (greeting + view-state selector)
// ---------------------------------------------------------------------------

/** Time-of-day greeting fragment, in Korean.
 *    05–11 아침 / 12–17 오후 / 18–04 저녁. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return '좋은 아침입니다';
  if (hour >= 12 && hour < 18) return '좋은 오후입니다';
  return '좋은 저녁입니다';
}

/** View-state selector — the single source of truth for the enum switch. */
export function selectViewState(brief: HomeBrief | null): HomeViewState {
  if (brief == null) return 'empty';
  if (brief.is_empty) return 'empty';
  return 'populated';
}

/** fix/h2-stellar-cluster-focus-in-real (2026-06-26):
 *
 * H-2 PO 의뢰서: "특정 노드 focus + 하이라이트" — cluster focus 가
 * real 모드에서 다시 작동해야 한다. d017a3a 의 simplification (항상
 * `/stellar` 반환) 위에, entity_uid 가 있고 linked_count > 0 인
 * 경우에만 `?cluster=<entity_uid>` 를 다시 붙인다.
 *
 * 작동 사슬:
 *   1. HomePage 가 brief.top_cluster.entity_uid 를 href 에 실음
 *   2. STELLAR mount 시 default real → real adapter 가 fact 노드들
 *      (subject_uid / object_uid 포함) 로딩
 *   3. pickClusterFocusNode 의 6-path resolver (3890f11) 가 entity_uid
 *      를 subject_uid / object_uid 기준으로 매칭 → 가장 spine 한 fact
 *      노드 (highest degree) 를 focus 로 picked
 *   4. handleClick → focus + 1-hop highlight 활성화
 *
 * fallback (entity_uid null / linked_count 0): 단순히 `/stellar` 진입.
 * `most_active` sentinel 은 PO 의뢰서에 명시적으로 제외 ("most_active
 * fallback 제거").
 */
export function clusterFocusHref(
  cluster: { entity_uid: string | null; linked_count: number } | null,
): string {
  if (cluster && cluster.entity_uid && cluster.linked_count > 0) {
    return `/stellar?cluster=${encodeURIComponent(cluster.entity_uid)}`;
  }
  return '/stellar';
}

// ---------------------------------------------------------------------------
// Visual primitives
// ---------------------------------------------------------------------------

/** Component 4 — greeting H1. Shared by both states.
 *
 * Hydration contract: the time-of-day branch (아침/오후/저녁) MUST be
 * decided on the client. SSR + first client paint use the neutral
 * "안녕하세요"; after mount we recompute against the local clock. */
function GreetingH1({ name }: { name: string }) {
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    setGreeting(greetingFor(new Date().getHours()));
  }, []);

  const text = greeting ?? '안녕하세요';

  return (
    <h1
      data-testid="home-greeting"
      style={{
        fontSize: 44,
        fontWeight: 600,
        letterSpacing: '-0.025em',
        color: TEXT_H1,
        lineHeight: 1.1,
        margin: 0,
        textAlign: 'center',
      }}
    >
      {text}, {name}님.
    </h1>
  );
}

/** feat/hearth-oracle-merge — "BE LUCID." brand line. Lives ABOVE the
 * greeting. Constant — never time-of-day branched.
 *
 * ★ REQ-014-A (PO 2026-07-02): 폰트 크기 12 → 24 로 키워 존재감 확보. mono +
 * uppercase 는 유지. 이전 크기는 "존재감이 없다" 는 피드백. 24 는 greeting
 * H1 (44) 보다는 작아 subject 관계는 유지된다.
 */
function BrandLine() {
  return (
    <p
      data-testid="home-brand-line"
      style={{
        margin: 0,
        marginBottom: 12,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 24,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        color: `color-mix(in oklab, ${ACCENT} 75%, #6b7d82)`,
        textAlign: 'center',
      }}
    >
      BE LUCID.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Populated arm — Components 5–9
// ---------------------------------------------------------------------------

/** Component 6 — active recall input.
 *
 * feat/hearth-oracle-merge: this is now the HEARTH Q&A entry. On submit
 * it routes through the inline AssistantQuery (ORACLE engine), not the
 * /recall route. Sphere state hooks are exposed via callbacks so the
 * parent can drive the SphereAnimation (focus → listening, submit →
 * thinking → speaking).
 */
function ActiveRecallInput({
  spaceId,
  sphereState,
  onSphereState,
  assistantRef,
}: {
  spaceId: string;
  sphereState: SphereState;
  onSphereState: (state: SphereState) => void;
  assistantRef: React.RefObject<AssistantQueryHandle | null>;
}) {
  const [value, setValue] = useState('');
  // fix(home-input-disable): PO reported that submitting while a query
  // is in flight just queues a second duplicate request. We treat the
  // sphere's "thinking" state as the in-flight signal and lock the
  // form: button + input disabled, Enter no-ops. State flips back to
  // "speaking" / "idle" the moment the assistant returns, re-enabling
  // the next question.
  const isInFlight = sphereState === 'thinking';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isInFlight) return;  // hard guard
    const q = value.trim();
    if (!q) return;
    if (!spaceId) {
      // No space available — fail-soft: don't crash, just don't submit.
      return;
    }
    // Drive the sphere through "thinking" then the Q&A component will
    // bump it to "speaking" once the result lands.
    onSphereState('thinking');
    void assistantRef.current?.submit(q);
  }

  function handleFocus() {
    onSphereState('listening');
  }

  function handleBlur() {
    // The Q&A component owns "thinking" / "speaking"; we only drop back
    // to idle if there's no active query.
    if (!value.trim()) onSphereState('idle');
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    if (e.target.value.length > 0) {
      onSphereState('listening');
    }
  }

  return (
    <form
      data-testid="home-recall-form"
      onSubmit={handleSubmit}
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 620,
        margin: '32px auto 0',
      }}
    >
      {/* Pulse dot */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 22,
          top: '50%',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: ACCENT,
          boxShadow: `0 0 10px ${ACCENT}`,
          animation: 'dotPulse 1.8s ease-in-out infinite',
          transform: 'translateY(-50%)',
        }}
      />
      <input
        data-testid="home-recall-input"
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        disabled={isInFlight}
        placeholder={isInFlight ? "검증된 지식에서 답을 찾는 중..." : "무엇이든 물어보세요. 검증된 것만 답합니다."}
        style={{
          width: '100%',
          height: 60,
          borderRadius: 16,
          background: isInFlight ? 'rgba(13,20,23,0.45)' : 'rgba(13,20,23,0.72)',
          border: `1px solid ${isInFlight ? '#1a2429' : INPUT_BORDER}`,
          padding: '0 66px 0 46px',
          fontSize: 16,
          color: TEXT_BODY,
          backdropFilter: 'blur(8px)',
          outline: 'none',
          boxSizing: 'border-box',
          opacity: isInFlight ? 0.45 : 1,
          cursor: isInFlight ? 'not-allowed' : 'text',
          transition: 'opacity 280ms ease, background 280ms ease, border-color 280ms ease',
        }}
      />
      <button
        data-testid="home-recall-submit"
        type="submit"
        aria-label="질문 전송"
        disabled={isInFlight}
        style={{
          position: 'absolute',
          right: 11,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 38,
          height: 38,
          borderRadius: 11,
          background: isInFlight ? '#1d3a36' : ACCENT,
          color: isInFlight ? '#3a5854' : '#06201c',
          border: 'none',
          opacity: isInFlight ? 0.55 : 1,
          cursor: isInFlight ? 'not-allowed' : 'pointer',
          fontSize: 17,
          fontWeight: 600,
          transition: 'opacity 280ms ease, background 280ms ease, color 280ms ease',
        }}
      >
        →
      </button>
      <style>{`
        @keyframes dotPulse {
          0%, 100% { opacity: 0.4; transform: translateY(-50%) scale(0.85); }
          50%      { opacity: 1;   transform: translateY(-50%) scale(1); }
        }
      `}</style>
    </form>
  );
}

/** Component 7 — 실데이터 지표 배지 pill (REQ-008 v2 / REQ-014-F).
 *
 * v1 (legacy): "제가 아는 건 당신이 검증한 N개의 사실뿐입니다…" — facts
 *   하나만 노출. PO: "사실 99 카피만 보임 → 실데이터 4 지표로 교체".
 *
 * v2 (REQ-008): "검증된 사실 N · 엔티티 M · 출처 P · 이번 주 +K" — mono 한 줄.
 *
 * ★ REQ-014-F (PO 2026-07-02) — 지표 중복 제거 + 배지화.
 *   PO verbatim: "'검증된 사실 87·엔티티 149·출처 8·이번 주 +87' 이거 왜
 *   2번이나 하는데? 최하단 지워야 할 것 아니냐?"
 *   "검색바 아래 잘 보이게 키우고 별도로 바긋 처리 해서 제대로 지표
 *   보여주던가"
 *
 *   조치:
 *     (a) 최하단 QuickStats 렌더 삭제 (중복 제거)
 *     (b) 이 컴포넌트를 검색바 바로 아래로 이동 (렌더 순서 조정)
 *     (c) mono 한 줄 → pill 배지 4개 (teal border · 큰 숫자 · 라벨)
 *
 *   test-id 유지: home-humility, home-humility-facts, -entities, -sources,
 *     -this-week — REQ-008 e2e 회귀 방지.
 */
function HumilityLine({
  facts,
  entities,
  sources,
  thisWeek,
}: {
  facts: number;
  entities: number;
  sources: number;
  thisWeek: number;
}) {
  return (
    <div
      data-testid="home-humility"
      role="group"
      aria-label="검증 지표"
      style={{
        marginTop: 18,
        marginBottom: 0,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 10,
        width: '100%',
        maxWidth: 620,
      }}
    >
      <MetricPill
        label="검증된 사실"
        testId="home-humility-facts"
        value={facts}
      />
      <MetricPill
        label="엔티티"
        testId="home-humility-entities"
        value={entities}
      />
      <MetricPill
        label="출처"
        testId="home-humility-sources"
        value={sources}
      />
      <MetricPill
        label="이번 주"
        testId="home-humility-this-week"
        value={thisWeek}
        accent
        plus
      />
    </div>
  );
}

/** REQ-014-F pill 프리미티브 — teal border, 굵은 숫자, 옅은 라벨.
 *   숫자 span 은 REQ-008 test-id 계약을 지키기 위해 그대로 유지. */
function MetricPill({
  label,
  value,
  testId,
  accent,
  plus,
}: {
  label: string;
  value: number;
  testId: string;
  accent?: boolean;
  plus?: boolean;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '7px 14px',
        borderRadius: 999,
        border: `1px solid ${accent ? 'rgba(63,224,198,0.55)' : 'rgba(63,224,198,0.28)'}`,
        background: accent ? 'rgba(63,224,198,0.10)' : 'rgba(13,20,23,0.55)',
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 12.5,
        letterSpacing: '0.02em',
        color: TEXT_DIMMER,
      }}
    >
      <span
        data-testid={testId}
        style={{
          color: accent ? ACCENT : '#e6eef0',
          fontWeight: 700,
          fontSize: 15,
        }}
      >
        {plus ? '+' : ''}
        {value}
      </span>
      <span style={{ color: accent ? '#8fe4d4' : TEXT_LABEL, fontWeight: 500 }}>
        {label}
      </span>
    </span>
  );
}

/** Component 8 — 오늘의 브리핑 card.
 * 3 rows: 검증 대기 / 주간 증가 / 클러스터. */
function TodayBriefingCard({ brief }: { brief: HomeBrief }) {
  const pending = brief.pending_validation;
  const thisWeek = brief.totals.this_week_validated;
  const cluster = brief.top_cluster;
  const showCluster =
    cluster != null &&
    cluster.linked_count > 0 &&
    (cluster.entity_name ?? '').length > 0;

  return (
    <section
      data-testid="home-briefing-card"
      aria-label="오늘의 브리핑"
      style={{
        width: '100%',
        maxWidth: 620,
        marginTop: 44,
        textAlign: 'left',
        background: CARD_BG,
        border: `1px solid ${CARD_BORDER}`,
        borderRadius: 18,
        padding: 8,
      }}
    >
      <header
        style={{
          padding: '14px 16px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: '#e6eef0' }}>
          오늘의 브리핑
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: '0.14em',
            color: TEXT_TINY,
          }}
        >
          TODAY&rsquo;S BRIEFING
        </span>
      </header>

      {/* Row 1 — 검증 대기 */}
      <BriefingRow
        testId="home-briefing-row-pending"
        icon={
          <span
            aria-hidden="true"
            style={{
              width: 13,
              height: 13,
              borderRadius: '50%',
              border: `1.6px solid ${ACCENT}`,
              display: 'inline-block',
            }}
          />
        }
        title={
          <>
            검증 대기{' '}
            <span
              data-testid="home-briefing-pending-count"
              style={{ color: ACCENT, fontWeight: 600 }}
            >
              {pending}건
            </span>
          </>
        }
        caption="어제 웹·뉴스에서 캡처됨"
        action={
          <Link
            href="/pending"
            data-testid="home-briefing-pending-cta"
            style={{
              background: ACCENT,
              color: '#06201c',
              fontWeight: 600,
              fontSize: 13.5,
              borderRadius: 10,
              padding: '10px 15px',
              textDecoration: 'none',
            }}
          >
            지금 검증 →
          </Link>
        }
      />

      {/* Row 2 — 주간 증가
       * feat/hearth-oracle-merge — "기록 보기" 의 destination 을
       * /recall → /ledger 로 정정 (LEDGER 페이지 자체는 ledger-view
       * 의뢰가 만듦; 이 PR 은 링크만 정정). */}
      <BriefingRow
        testId="home-briefing-row-this-week"
        icon={
          <span
            aria-hidden="true"
            style={{
              color: ACCENT,
              fontSize: 16,
              fontWeight: 700,
              lineHeight: 1,
            }}
          >
            ✓
          </span>
        }
        title={
          <>
            이번 주{' '}
            <span
              data-testid="home-briefing-this-week-count"
              style={{ color: ACCENT, fontWeight: 600 }}
            >
              +{thisWeek}개
            </span>{' '}
            검증됨
          </>
        }
        caption="지난주보다 활발한 한 주였습니다"
        action={
          <Link
            href="/ledger"
            data-testid="home-briefing-this-week-cta"
            style={{
              color: '#8aa0a5',
              fontSize: 13.5,
              textDecoration: 'none',
            }}
          >
            기록 보기 →
          </Link>
        }
      />

      {/* Row 3 — 클러스터.
       * feat/hearth-oracle-merge — "살펴보기" 의 destination 을
       * /recall → /stellar?cluster=<entity_uid> 로 정정. STELLAR 가
       * 가장 활발한 클러스터에 카메라 focus 한다. */}
      {showCluster ? (
        <BriefingRow
          testId="home-briefing-row-cluster"
          icon={
            <svg
              aria-hidden="true"
              width={16}
              height={16}
              viewBox="0 0 16 16"
              style={{ display: 'block' }}
            >
              <circle cx={4} cy={4} r={1.7} fill={ACCENT} />
              <circle cx={12} cy={5} r={1.7} fill={ACCENT} />
              <circle cx={8} cy={12} r={1.7} fill={ACCENT} />
              <line
                x1={4}
                y1={4}
                x2={12}
                y2={5}
                stroke={ACCENT}
                strokeWidth={1}
                opacity={0.6}
              />
              <line
                x1={4}
                y1={4}
                x2={8}
                y2={12}
                stroke={ACCENT}
                strokeWidth={1}
                opacity={0.6}
              />
              <line
                x1={12}
                y1={5}
                x2={8}
                y2={12}
                stroke={ACCENT}
                strokeWidth={1}
                opacity={0.6}
              />
            </svg>
          }
          title={
            <>
              <span
                data-testid="home-briefing-cluster-name"
                style={{ color: ACCENT, fontWeight: 600 }}
              >
                {cluster!.entity_name}
              </span>{' '}
              클러스터가 가장 활발합니다
            </>
          }
          caption={`최근 7일간 사실 ${cluster!.linked_count}건이 연결됨`}
          action={
            <Link
              href={clusterFocusHref(cluster)}
              data-testid="home-briefing-cluster-cta"
              style={{
                color: '#8aa0a5',
                fontSize: 13.5,
                textDecoration: 'none',
              }}
            >
              살펴보기 →
            </Link>
          }
        />
      ) : null}
    </section>
  );
}

function BriefingRow({
  testId,
  icon,
  title,
  caption,
  action,
}: {
  testId: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  caption: string;
  action: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '15px 16px',
        borderTop: `1px solid ${ROW_BORDER}`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: `color-mix(in oklab, ${ACCENT} 13%, transparent)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: TEXT_BODY }}>{title}</div>
        <div
          style={{
            marginTop: 2,
            fontSize: 12.5,
            color: TEXT_DIM,
          }}
        >
          {caption}
        </div>
      </div>
      <div style={{ flex: '0 0 auto' }}>{action}</div>
    </div>
  );
}

/** Component 9 — 빠른 현황 바.
 *
 * ★ REQ-014-F (PO 2026-07-02) — 삭제.
 *   PO verbatim: "'검증된 사실 87·엔티티 149·출처 8·이번 주 +87' 이거 왜
 *   2번이나 하는데? 최하단 지워야 할 것 아니냐?"
 *   → HumilityLine 이 pill 배지로 승격했으므로 QuickStats 는 중복.
 *   컴포넌트 자체를 제거해 dead-code 방지.
 */

function HomePopulated({
  brief,
  spaceId,
  sphereState,
  onSphereState,
  assistantRef,
}: {
  brief: HomeBrief;
  spaceId: string;
  sphereState: SphereState;
  onSphereState: (state: SphereState) => void;
  assistantRef: React.RefObject<AssistantQueryHandle | null>;
}) {
  return (
    <div
      data-testid="home-populated"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
      }}
    >
      <ActiveRecallInput
        spaceId={spaceId}
        sphereState={sphereState}
        onSphereState={onSphereState}
        assistantRef={assistantRef}
      />
      {/* ★ REQ-014-F: 지표 pill 을 검색바 바로 아래로 이동.
       *   이전에는 AssistantQuery + 하단 QuickStats 두 곳에 렌더돼
       *   중복이었음. PO 지시로 최하단 삭제 + 검색바 아래 승격. */}
      <HumilityLine
        facts={brief.totals.facts}
        entities={brief.totals.entities}
        sources={brief.totals.sources}
        thisWeek={brief.totals.this_week_validated}
      />
      {/* feat/hearth-oracle-merge — inline Q&A surface. Renders below the
       * input only when there's a query / result / error. The sphere
       * state syncs through the assistantRef + onSphereState plumbing. */}
      <AssistantQuery
        ref={assistantRef}
        spaceId={spaceId}
        onStateChange={onSphereState}
      />
      <TodayBriefingCard brief={brief} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty arm — Components E1–E4
// ---------------------------------------------------------------------------

function ColdEmptyLine() {
  return (
    <p
      data-testid="home-empty-line"
      style={{
        marginTop: 20,
        marginBottom: 0,
        fontSize: 18,
        lineHeight: 1.75,
        color: TEXT_SECONDARY,
        maxWidth: 560,
        textWrap: 'pretty' as React.CSSProperties['textWrap'],
        textAlign: 'center',
      }}
    >
      {/* ★ REQ-014-A (PO 2026-07-02): 이전 "당신의 그래프는 아직 비어 있습니다.
       *   첫 사실을 캡처하면 여기서 살아납니다." → 옵션 A (확장 설치 + 첫
       *   문장) 로 교체. 온보딩 3단계와의 어조를 맞추고 CTA 로 자연스럽게
       *   유도한다. */}
      확장을 설치하고 첫 문장을 담아보세요.
    </p>
  );
}

/**
 * ★ REQ-014-A (PO 2026-07-02) — ColdCTA 재설계.
 *
 * 이전: "첫 사실 캡처하기 →" 텍스트 + href="#" (죽은 링크). PO 는 "눌러도
 * 목적 불명" 이라고 지적.
 *
 * 신규: "확장 설치하기 →" — Chrome Web Store 링크 (아직 상장 안 됐으므로)
 * 로컬 설치 안내 modal 을 열어 unpacked extension 로드 방법을 3단계로
 * 안내한다. Chrome Web Store 준비되면 modal 내부의 링크만 교체하면 된다.
 */
function ColdCTA() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        marginTop: 30,
      }}
    >
      <button
        type="button"
        data-testid="home-empty-cta"
        onClick={() => setModalOpen(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 9,
          background: ACCENT,
          color: '#06201c',
          fontWeight: 600,
          fontSize: 15,
          borderRadius: 13,
          padding: '15px 24px',
          boxShadow: `0 0 32px color-mix(in oklab, ${ACCENT} 26%, transparent)`,
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        확장 설치하기 →
      </button>
      <p
        style={{
          marginTop: 12,
          marginBottom: 0,
          fontSize: 13,
          color: TEXT_DIM,
          textAlign: 'center',
        }}
      >
        브라우저 확장을 설치하면 웹·뉴스·이미지에서 바로 캡처할 수 있습니다.
      </p>
      {modalOpen ? (
        <ExtensionInstallModal onClose={() => setModalOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * ★ REQ-014-A (PO 2026-07-02) — 로컬 확장 설치 안내 modal.
 *
 * Chrome Web Store 상장 전까지의 임시 안내. 상장 완료 후에는 아래의 3-step
 * 로컬 안내를 store 링크 하나로 교체하면 된다 (data-testid 는 유지 권장).
 */
function ExtensionInstallModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-testid="home-extension-install-modal"
      role="dialog"
      aria-modal="true"
      aria-label="확장 설치 안내"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 8, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0b1215',
          border: `1px solid ${CARD_BORDER}`,
          borderRadius: 18,
          padding: 28,
          maxWidth: 480,
          width: '100%',
          color: TEXT_BODY,
          boxShadow: `0 20px 60px rgba(0,0,0,0.5)`,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: TEXT_H1,
          }}
        >
          Lucid 확장 설치
        </h2>
        <p
          style={{
            marginTop: 8,
            marginBottom: 20,
            fontSize: 13,
            color: TEXT_DIM,
            lineHeight: 1.6,
          }}
        >
          Chrome Web Store 상장 전 임시 안내입니다. 아래 3단계로 unpacked 확장을
          로드해 주세요.
        </p>
        <ol
          data-testid="home-extension-install-steps"
          style={{
            margin: 0,
            paddingLeft: 22,
            fontSize: 14,
            lineHeight: 1.75,
            color: TEXT_BODY,
          }}
        >
          <li>
            브라우저 주소창에{' '}
            <code
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 12,
                background: '#0e1a1c',
                padding: '1px 6px',
                borderRadius: 4,
              }}
            >
              chrome://extensions
            </code>{' '}
            를 열고 우측 상단 "개발자 모드" 를 켭니다.
          </li>
          <li>"압축해제된 확장 프로그램 로드" 를 눌러 저장소의 <code style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, background: '#0e1a1c', padding: '1px 6px', borderRadius: 4 }}>extension/</code> 폴더를 선택합니다.</li>
          <li>확장 아이콘을 툴바에 고정하고, 웹에서 아무 문장이나 선택 후 클릭해 첫 사실을 담아보세요.</li>
        </ol>
        <button
          type="button"
          data-testid="home-extension-install-modal-close"
          onClick={onClose}
          style={{
            marginTop: 24,
            width: '100%',
            background: ACCENT,
            color: '#06201c',
            fontWeight: 600,
            fontSize: 14,
            border: 'none',
            borderRadius: 12,
            padding: '12px 16px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          알겠습니다
        </button>
      </div>
    </div>
  );
}

/**
 * ★ REQ-014-A (PO 2026-07-02) — 비활성 검색 바 감쇠.
 *
 * 이전: placeholder + `cursor: not-allowed` + dashed 테두리로 "금지 사인" 이
 * 3중 강조되어 과했다. PO 는 opacity 0.5 + 기본 disabled 만으로 충분하다고
 * 판단.
 *
 * 신규: cursor: not-allowed 제거 (그냥 disabled 만), dashed → solid,
 * wrapper 에 opacity 0.5. placeholder 자체는 유지 (온보딩 컨텍스트로).
 */
function DisabledRecallInput() {
  return (
    <div
      data-testid="home-empty-recall"
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 620,
        margin: '32px auto 0',
        opacity: 0.5,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 22,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#33444a',
        }}
      />
      <input
        data-testid="home-empty-recall-input"
        type="text"
        disabled
        placeholder="검증된 사실이 쌓이면 여기서 물어볼 수 있습니다"
        style={{
          width: '100%',
          height: 56,
          borderRadius: 16,
          background: 'rgba(13,20,23,0.35)',
          border: `1px solid ${INPUT_BORDER}`,
          padding: '0 24px 0 46px',
          fontSize: 16,
          color: '#6b7d82',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

/**
 * ★ REQ-014-A (PO 2026-07-02) — 온보딩 카드 문구 verbatim 교체.
 *
 * A6: "여기서 시작합니다" / "시작하기" 헤더 텍스트 제거. 목적 불명한
 *   중복 라벨이었음. 카드 자체가 3-step 구조라 헤더 없이도 의도 명확.
 *
 * A7: PO 제안 verbatim 3단계로 교체.
 *   1) 확장 설치 — 웹 어디서든 클릭 한 번으로 정보를 담습니다
 *   2) AI가 정리 — 문장에서 검증할 사실을 뽑아냅니다
 *   3) 당신이 승인 — 당신이 확인한 사실만 지식이 됩니다
 *
 * 문구는 e2e 에서 verbatim 검증되므로 수정 시 spec 도 함께 갱신 필요.
 */
function GettingStartedCard() {
  const steps: Array<[string, string]> = [
    ['확장 설치', '웹 어디서든 클릭 한 번으로 정보를 담습니다'],
    ['AI가 정리', '문장에서 검증할 사실을 뽑아냅니다'],
    ['당신이 승인', '당신이 확인한 사실만 지식이 됩니다'],
  ];
  return (
    <section
      data-testid="home-empty-guide"
      style={{
        width: '100%',
        maxWidth: 560,
        marginTop: 44,
        textAlign: 'left',
        background: CARD_BG,
        border: `1px solid ${CARD_BORDER}`,
        borderRadius: 18,
        padding: 8,
      }}
    >
      {steps.map(([title, desc], idx) => (
        <div
          key={title}
          data-testid={`home-empty-step-${idx + 1}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '15px 16px',
            // REQ-014-A: 헤더 제거로 첫 스텝은 위쪽 divider 불필요 (카드
            // 자체 border 로 충분). 두 번째부터만 divider 표시.
            borderTop: idx === 0 ? 'none' : `1px solid ${ROW_BORDER}`,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              border: `1px solid color-mix(in oklab, ${ACCENT} 35%, transparent)`,
              color: ACCENT,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
            }}
          >
            {idx + 1}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, color: TEXT_BODY }}>{title}</div>
            <div
              style={{
                marginTop: 2,
                fontSize: 12.5,
                color: TEXT_DIM,
              }}
            >
              {desc}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * B-61 — personalised welcome line.
 *
 * Rendered above the cold-start 3-step card when the caller is a
 * newly registered user (`is_new_user=true` from /api/auth/me).
 */
function WelcomeLine({ displayName }: { displayName: string | null }) {
  const name = displayName?.trim() || '게스트';
  return (
    <div
      data-testid="home-welcome-line"
      style={{
        fontSize: 13,
        opacity: 0.8,
        marginBottom: 16,
        color: TEXT_BODY,
        textAlign: 'center',
      }}
    >
      환영합니다, {name}님. 첫 사실을 캡처하면 여기서 살아납니다.
    </div>
  );
}

function HomeColdStart({ me }: { me: MeResponse | null }) {
  const showWelcome = me?.is_new_user === true;
  return (
    <div
      data-testid="home-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
      }}
    >
      {showWelcome ? (
        <WelcomeLine displayName={me?.display_name ?? null} />
      ) : null}
      <ColdEmptyLine />
      <ColdCTA />
      <DisabledRecallInput />
      <GettingStartedCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Common shell + page entry
// ---------------------------------------------------------------------------

/** The visual frame both states share. */
function HomeShellCommon({
  sphereState,
  userName,
  children,
}: {
  sphereState: SphereState;
  userName: string;
  children: React.ReactNode;
}) {
  return (
    <main
      data-testid="home-page"
      style={{
        position: 'relative',
        background: BG,
        minHeight: 'calc(100vh - 64px)',
        overflow: 'hidden',
      }}
    >
      {/* Background glow */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 0,
          backgroundImage: [
            `radial-gradient(1100px 620px at 50% -2%, color-mix(in oklab, ${ACCENT} 9%, transparent), transparent 60%)`,
            `radial-gradient(800px 500px at 88% 8%, color-mix(in oklab, ${ACCENT} 5%, transparent), transparent 55%)`,
          ].join(', '),
        }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          maxWidth: 760,
          margin: '0 auto',
          padding: '54px 28px 60px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <HearthSphere state={sphereState} />
        <BrandLine />
        <GreetingH1 name={userName} />
        {children}
        {/*
         * ★ REQ-014-A (PO 2026-07-02) — home-version-footer 제거.
         *   • 이전에는 HomePage 본문 하단 + AppShell 글로벌 푸터에 "Lucid v0.x.x"
         *     가 이중 노출 → PO 정리 원함. (REQ-007-v2 후속으로 명시된 잔존 아이템.)
         *   • 진짜 소스 = AppShell 의 app-shell-version-footer (모든 라우트 글로벌
         *     chrome). home 페이지의 본문 내 decorative footer 는 삭제.
         */}
      </div>
    </main>
  );
}

/** Public entry. Mounted by `app/home/page.tsx`. */
export function HomePage({ userName = '박기흥' }: { userName?: string }) {
  const { brief } = useHomeBrief();
  const { me } = useAuthMe();

  // feat/hearth-oracle-merge — sphere state lives here so all four
  // states are reachable: idle (default) / listening (input focus or
  // typing) / thinking (Q&A in flight) / speaking (answer mounted).
  const [sphereState, setSphereState] = useState<SphereState>('idle');
  const assistantRef = useRef<AssistantQueryHandle | null>(null);

  const handleSphereState = useCallback((s: SphereState) => {
    setSphereState(s);
  }, []);

  const view: HomeViewState = useMemo(() => selectViewState(brief), [brief]);

  const meName = me
    ? (me.display_name?.trim() || me.email.split('@')[0] || me.email)
    : null;
  const greetingName = meName ?? userName;
  const spaceId = me?.default_space_id ?? '';

  return (
    <HomeShellCommon sphereState={sphereState} userName={greetingName}>
      {renderArm(view, brief, me, spaceId, sphereState, handleSphereState, assistantRef)}
      {/* Keep TEXT_LABEL referenced so the design-token contract is
          visible without an unused-var warning. */}
      <span
        style={{ display: 'none' }}
        aria-hidden="true"
        data-color={TEXT_LABEL}
      />
    </HomeShellCommon>
  );
}

function renderArm(
  view: HomeViewState,
  brief: HomeBrief | null,
  me: MeResponse | null,
  spaceId: string,
  sphereState: SphereState,
  onSphereState: (s: SphereState) => void,
  assistantRef: React.RefObject<AssistantQueryHandle | null>,
) {
  switch (view) {
    case 'populated':
      return (
        <HomePopulated
          brief={brief as HomeBrief}
          spaceId={spaceId}
          sphereState={sphereState}
          onSphereState={onSphereState}
          assistantRef={assistantRef}
        />
      );
    case 'empty':
      return <HomeColdStart me={me} />;
    case 'unknown':
      return null;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
