/**
 * B-59 — Home (/home) two-state surface.
 *
 * Implements the "AI 비서 홈" handoff from the design README:
 *
 *   - `populated` (Components 2–9): orb + greeting + 능동 브리핑 + recall
 *     input + 겸손 한 줄 + 오늘의 브리핑 카드 + 빠른 현황 바.
 *   - `empty`     (Components E1–E4): orb + greeting + 빈 상태 한 줄 +
 *     "첫 사실 캡처하기" CTA + disabled recall + '여기서 시작합니다' 3-step.
 *   - `unknown`   (reserved): the structure switches on a `HomeViewState`
 *     enum so a follow-up ticket can slot the "不知" state in without
 *     re-architecting the surface. The 'unknown' arm intentionally
 *     renders nothing here — that's B-59's explicit scope boundary.
 *
 * Fail-soft contract: when `useHomeBrief()` cannot load (B-55 not wired,
 * 401, network error), `brief` is `null`. We treat that as `empty` —
 * the cold-start surface is meaningful copy + a CTA, never a crash
 * screen. (DR-089 / B-57 "fail-soft" precedent.)
 *
 * The shared shell (header + nav + profile) comes from `app/layout.tsx`
 * (AppShell, B-57). This component is the body only.
 *
 * Visual scope clarification: per the task, animation is a nice-to-have,
 * not a requirement. We ship pure-CSS static visuals — the orb is a
 * radial-gradient circle, not a multi-ring animated assembly. The
 * design tokens (colours, spacing, typography) are taken verbatim from
 * the handoff README "Design Tokens" section.
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useHomeBrief } from '@/lib/useHomeBrief';
import { useAuthMe } from '@/lib/useAuthMe';
import { LUCID_VERSION } from '@/lib/version';
import type { HomeBrief } from '@/lib/types';
import type { MeResponse } from '@/lib/api';

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

/** Time-of-day greeting fragment, in Korean. Mirrors the handoff:
 *    05–11 아침 / 12–17 오후 / 18–04 저녁. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return '좋은 아침입니다';
  if (hour >= 12 && hour < 18) return '좋은 오후입니다';
  return '좋은 저녁입니다';
}

/** View-state selector — the single source of truth for the enum switch.
 * Exported so the test can pin the exact branching contract. */
export function selectViewState(brief: HomeBrief | null): HomeViewState {
  // Fail-soft: a missing brief is treated as cold-start, not as an
  // error screen. The handoff's "empty" copy is meaningful.
  if (brief == null) return 'empty';
  if (brief.is_empty) return 'empty';
  return 'populated';
}

// ---------------------------------------------------------------------------
// Visual primitives
// ---------------------------------------------------------------------------

/** Component 2 — orb. Pure CSS radial gradient + glow. Animation
 * (orbPulse / orbBreath) is a nice-to-have applied via inline keyframes
 * but the orb stays visible if animation never runs. */
function OrbVisual() {
  return (
    <div
      data-testid="home-orb"
      style={{
        position: 'relative',
        width: 230,
        height: 230,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 36,
      }}
    >
      {/* Halo */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: -46,
          borderRadius: '50%',
          background: `radial-gradient(circle, color-mix(in oklab, ${ACCENT} 24%, transparent), transparent 62%)`,
          filter: 'blur(10px)',
          animation: 'orbBreath 5.2s ease-in-out infinite',
        }}
      />
      {/* Outer ring */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 222,
          height: 222,
          borderRadius: '50%',
          border: `1px solid color-mix(in oklab, ${ACCENT} 26%, transparent)`,
        }}
      />
      {/* Inner dashed ring */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 176,
          height: 176,
          borderRadius: '50%',
          border: `1px dashed color-mix(in oklab, ${ACCENT} 22%, transparent)`,
        }}
      />
      {/* Core sphere — the 124px circle the task calls out by name. */}
      <div
        aria-hidden="true"
        style={{
          position: 'relative',
          width: 124,
          height: 124,
          borderRadius: '50%',
          background: `radial-gradient(circle at 38% 30%, color-mix(in oklab, ${ACCENT} 88%, white 12%), color-mix(in oklab, ${ACCENT} 66%, #06201c) 52%, #04130f 100%)`,
          boxShadow: `0 0 56px color-mix(in oklab, ${ACCENT} 42%, transparent), inset 0 0 32px color-mix(in oklab, ${ACCENT} 28%, transparent)`,
          animation: 'orbPulse 4.2s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes orbPulse {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          50%      { transform: scale(1.045); filter: brightness(1.12); }
        }
        @keyframes orbBreath {
          0%, 100% { opacity: 0.55; transform: scale(0.98); }
          50%      { opacity: 0.95; transform: scale(1.06); }
        }
        @keyframes dotPulse {
          0%, 100% { opacity: 0.4; transform: translateY(-50%) scale(0.85); }
          50%      { opacity: 1;   transform: translateY(-50%) scale(1); }
        }
      `}</style>
    </div>
  );
}

/** Mono status label (Component 3 / E상태 라벨 자리). */
function StatusLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="home-status-label"
      style={{
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 12,
        letterSpacing: '0.14em',
        color: `color-mix(in oklab, ${ACCENT} 75%, #6b7d82)`,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

/** Component 4 — greeting H1. Shared by both states.
 *
 * Hydration contract: the time-of-day branch (아침/오후/저녁) MUST be
 * decided on the client, not during SSR. Otherwise the server renders
 * with the server-process TZ (UTC on Vercel/Render) and the client
 * re-renders with the user's local TZ, producing a React hydration
 * mismatch warning (`HomePage.tsx:187 GreetingH1` — server "아침" vs
 * client "오후").
 *
 * Fix: first paint (SSR + first client paint before effects run) uses
 * a neutral, TZ-independent greeting "안녕하세요". After mount, the
 * effect computes the local-time greeting and we re-render. The
 * data-testid + name interpolation stay identical so the existing
 * test contract ("home-greeting" contains the userName) holds in both
 * paints.
 */
function GreetingH1({ name }: { name: string }) {
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    setGreeting(greetingFor(new Date().getHours()));
  }, []);

  // First paint (SSR + pre-effect client) — neutral fallback that is
  // identical on both sides of the hydration boundary.
  const text = greeting ?? '안녕하세요';

  return (
    <h1
      data-testid="home-greeting"
      style={{
        fontSize: 40,
        fontWeight: 600,
        letterSpacing: '-0.025em',
        color: TEXT_H1,
        lineHeight: 1.15,
        margin: 0,
        textAlign: 'center',
      }}
    >
      {text}, {name}님.
    </h1>
  );
}

// ---------------------------------------------------------------------------
// Populated arm — Components 5–9
// ---------------------------------------------------------------------------

/** Component 5 — 능동 브리핑 문단. Numbers inline in accent. */
function ActiveBriefing({
  facts,
  pending,
}: {
  facts: number;
  pending: number;
}) {
  return (
    <p
      data-testid="home-briefing-text"
      style={{
        marginTop: 20,
        marginBottom: 0,
        fontSize: 18,
        lineHeight: 1.75,
        color: TEXT_SECONDARY,
        maxWidth: 600,
        textWrap: 'pretty' as React.CSSProperties['textWrap'],
        textAlign: 'center',
      }}
    >
      지난 검증 이후{' '}
      <span
        data-testid="home-briefing-facts"
        style={{ color: ACCENT, fontWeight: 600 }}
      >
        {facts}개
      </span>
      의 사실이 당신의 그래프에 살아 있습니다.{' '}
      {pending > 0 ? (
        <>
          어제 캡처하신{' '}
          <span
            data-testid="home-briefing-pending"
            style={{ color: ACCENT, fontWeight: 600 }}
          >
            {pending}건
          </span>
          이 검증을 기다리고 있습니다.
        </>
      ) : (
        <span data-testid="home-briefing-no-pending">검증 대기는 없습니다.</span>
      )}
    </p>
  );
}

/** Component 6 — active recall input. Submit navigates to /recall?q=... */
function ActiveRecallInput() {
  const router = useRouter();
  const [value, setValue] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    router.push(`/recall?q=${encodeURIComponent(q)}`);
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
        onChange={(e) => setValue(e.target.value)}
        placeholder="무엇이든 물어보세요. 검증된 것만 답합니다."
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
        }}
      />
      <button
        data-testid="home-recall-submit"
        type="submit"
        aria-label="recall 전송"
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
          fontSize: 17,
          cursor: 'pointer',
          fontWeight: 600,
        }}
      >
        →
      </button>
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
 * 3 rows: 검증 대기 / 주간 증가 / 클러스터. The cluster row hides when
 * `top_cluster.linked_count <= 0` (the backend collapses to an empty
 * cluster object in that case — guarding the UI keeps zeros out). */
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

      {/* Row 2 — 주간 증가 */}
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
            href="/recall"
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

      {/* Row 3 — 클러스터 (hidden when linked_count == 0) */}
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
              href="/recall"
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

function HomePopulated({ brief }: { brief: HomeBrief }) {
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
      <ActiveBriefing
        facts={brief.totals.facts}
        pending={brief.pending_validation}
      />
      <ActiveRecallInput />
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
 * newly registered user (`is_new_user=true` from /api/auth/me). When
 * `displayName` is null (e.g. user registered without a name), we
 * fall back to "게스트" so the copy is still warm and the test
 * contract stays deterministic.
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
  // Only show the personalised welcome line for genuinely new users.
  // Returning users with an empty graph (deleted all their facts, or
  // never captured anything in 7+ days) get the generic cold-start
  // copy without the welcome ribbon.
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

/** The visual frame both states share: background glow + centred column +
 * orb + greeting + status label slot. The arm-specific content goes
 * inside `children` (below the greeting). */
function HomeShellCommon({
  statusLabel,
  userName,
  children,
}: {
  statusLabel: string;
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
        <OrbVisual />
        <StatusLabel>{statusLabel}</StatusLabel>
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

/** Public entry. Mounted by `app/home/page.tsx`.
 *
 * Tests may pass `userName` to pin the greeting without mocking the
 * default identity. Until login is wired (B-58 follow-up) the default
 * mirrors AppShell's mock identity "박기흥". */
export function HomePage({ userName = '박기흥' }: { userName?: string }) {
  const { brief } = useHomeBrief();
  // B-61 — pull identity/cold-start signal so the welcome line can
  // appear above the 3-step card for genuinely new users.
  const { me } = useAuthMe();

  // The enum + switch is the contract: a follow-up ticket can wire
  // 'unknown' without re-architecting this component.
  const view: HomeViewState = useMemo(() => selectViewState(brief), [brief]);

  const statusLabel =
    view === 'empty'
      ? 'LUCID · 첫 사실을 기다리는 중'
      : view === 'unknown'
        ? 'LUCID · 경계 밖'
        : 'LUCID · 대기 중';

  // Prefer the authenticated display name when available — keeps the
  // greeting in sync with the AppShell. Falls back to the prop (test
  // pinning) and finally to the design-mock literal.
  const meName = me
    ? (me.display_name?.trim() || me.email.split('@')[0] || me.email)
    : null;
  const greetingName = meName ?? userName;

  return (
    <HomeShellCommon statusLabel={statusLabel} userName={greetingName}>
      {renderArm(view, brief, me)}
      {/* Keep TEXT_LABEL referenced so the design-token contract is
          visible without an unused-var warning. The token is reserved
          for the future 'unknown' arm's primary button label color. */}
      <span style={{ display: 'none' }} aria-hidden="true" data-color={TEXT_LABEL} />
    </HomeShellCommon>
  );
}

function renderArm(
  view: HomeViewState,
  brief: HomeBrief | null,
  me: MeResponse | null,
) {
  switch (view) {
    case 'populated':
      // selectViewState() guarantees brief != null && !is_empty here.
      return <HomePopulated brief={brief as HomeBrief} />;
    case 'empty':
      return <HomeColdStart me={me} />;
    case 'unknown':
      // Reserved for the next ticket — explicit `null` so the switch
      // exhaustively covers the enum.
      return null;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
