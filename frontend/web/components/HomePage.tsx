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
import { LUCID_VERSION } from '@/lib/version';
import type { HomeBrief } from '@/lib/types';
import type { MeResponse } from '@/lib/api';
import {
  AssistantQuery,
  type AssistantQueryHandle,
} from './AssistantQuery';
import {
  SphereAnimation,
  type SphereState,
} from './SphereAnimation';

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

/** fix/stellar-default-real (2026-06-26 PO directive):
 * "살펴보기" 가 cluster focus 를 시도하지 않고 단순히 STELLAR 진입.
 * STELLAR 의 default mode 가 real 이라 entity 데이터가 그대로 보임 —
 * 사용자가 직접 클러스터 탐색. 이전의 ?cluster=<entity_uid> 매칭은
 * synthetic 모드 first-visit 에서 항상 fail 했고, real 진입 후에도
 * 노드 매칭이 entity meta-network 미작성으로 부정확. 단순한 path 가 PO 합의. */
export function clusterFocusHref(
  _cluster: { entity_uid: string | null; linked_count: number } | null,
): string {
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
 * greeting; intentionally small so the greeting reads as the visual
 * subject. Constant — never time-of-day branched. */
function BrandLine() {
  return (
    <p
      data-testid="home-brand-line"
      style={{
        margin: 0,
        marginBottom: 12,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 12,
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
          background: 'rgba(13,20,23,0.72)',
          border: `1px solid ${INPUT_BORDER}`,
          padding: '0 66px 0 46px',
          fontSize: 16,
          color: TEXT_BODY,
          backdropFilter: 'blur(8px)',
          outline: 'none',
          boxSizing: 'border-box',
          opacity: isInFlight ? 0.6 : 1,
          cursor: isInFlight ? 'not-allowed' : 'text',
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
          background: ACCENT,
          color: '#06201c',
          border: 'none',
          opacity: isInFlight ? 0.4 : 1,
          cursor: isInFlight ? 'not-allowed' : 'pointer',
          fontSize: 17,
          fontWeight: 600,
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

/** Component 7 — 겸손 한 줄. */
function HumilityLine({ facts }: { facts: number }) {
  return (
    <p
      data-testid="home-humility"
      style={{
        marginTop: 15,
        marginBottom: 0,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 12,
        letterSpacing: '0.02em',
        color: TEXT_DIMMEST,
        textAlign: 'center',
      }}
    >
      제가 아는 건 당신이 검증한 {facts}개의 사실뿐입니다. 그 경계 안에서
      답하겠습니다.
    </p>
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

/** Component 9 — 빠른 현황 바. */
function QuickStats({ brief }: { brief: HomeBrief }) {
  return (
    <div
      data-testid="home-quick-stats"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        marginTop: 30,
        fontSize: 13,
        color: TEXT_DIMMER,
        flexWrap: 'wrap',
      }}
    >
      <Stat
        label="검증된 사실"
        value={brief.totals.facts}
        testId="home-stat-facts"
      />
      <Sep />
      <Stat
        label="엔티티"
        value={brief.totals.entities}
        testId="home-stat-entities"
      />
      <Sep />
      <Stat
        label="출처"
        value={brief.totals.sources}
        testId="home-stat-sources"
      />
      <Sep />
      <Stat
        label="이번 주"
        value={brief.totals.this_week_validated}
        plus
        accentNumber
        testId="home-stat-this-week"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  plus,
  accentNumber,
  testId,
}: {
  label: string;
  value: number;
  plus?: boolean;
  accentNumber?: boolean;
  testId: string;
}) {
  return (
    <span data-testid={testId}>
      {label}{' '}
      <span
        style={{
          color: accentNumber ? ACCENT : '#aebfc2',
          fontWeight: 600,
        }}
      >
        {plus ? '+' : ''}
        {value}
      </span>
    </span>
  );
}

function Sep() {
  return <span style={{ opacity: 0.4 }}>·</span>;
}

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
      {/* feat/hearth-oracle-merge — inline Q&A surface. Renders below the
       * input only when there's a query / result / error. The sphere
       * state syncs through the assistantRef + onSphereState plumbing. */}
      <AssistantQuery
        ref={assistantRef}
        spaceId={spaceId}
        onStateChange={onSphereState}
      />
      <HumilityLine facts={brief.totals.facts} />
      <TodayBriefingCard brief={brief} />
      <QuickStats brief={brief} />
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
      당신의 그래프는 아직 비어 있습니다. 첫 사실을 캡처하면 여기서 살아납니다.
    </p>
  );
}

function ColdCTA() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        marginTop: 30,
      }}
    >
      <a
        data-testid="home-empty-cta"
        href="#"
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
          textDecoration: 'none',
        }}
      >
        첫 사실 캡처하기 →
      </a>
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
    </div>
  );
}

function DisabledRecallInput() {
  return (
    <div
      data-testid="home-empty-recall"
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 620,
        margin: '32px auto 0',
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
          border: `1px dashed #1b2629`,
          padding: '0 24px 0 46px',
          fontSize: 16,
          color: '#6b7d82',
          cursor: 'not-allowed',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function GettingStartedCard() {
  const steps: Array<[string, string]> = [
    ['브라우저 확장 설치', '웹 어디서든 캡처 버튼이 생깁니다'],
    ['정보를 캡처', 'AI가 주어·서술어·목적어 사실 후보로 분해합니다'],
    ['당신이 검증', '승인한 사실만 그래프에 저장되어 여기서 살아납니다'],
  ];
  return (
    <section
      data-testid="home-empty-guide"
      aria-label="여기서 시작합니다"
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
      <header
        style={{
          padding: '14px 16px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: '#e6eef0' }}>
          여기서 시작합니다
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: '0.14em',
            color: TEXT_TINY,
          }}
        >
          GETTING STARTED
        </span>
      </header>
      {steps.map(([title, desc], idx) => (
        <div
          key={title}
          data-testid={`home-empty-step-${idx + 1}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '15px 16px',
            borderTop: `1px solid ${ROW_BORDER}`,
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
        <SphereAnimation state={sphereState} />
        <BrandLine />
        <GreetingH1 name={userName} />
        {children}
        <footer
          data-testid="home-version-footer"
          style={{
            marginTop: 48,
            fontSize: 11,
            color: TEXT_DIMMEST,
            textAlign: 'center',
            letterSpacing: '0.04em',
          }}
        >
          Lucid v{LUCID_VERSION}
        </footer>
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
