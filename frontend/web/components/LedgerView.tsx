'use client';

/**
 * LedgerView — feat/ledger-view (제3의 뷰).
 *
 * Chronological list of recently validated facts in one KS, paged with
 * "더 보기" load-more. Sits alongside DECIDE (validation queue, pre-
 * validation) and RECALL (search). The destination for HEARTH
 * "기록 보기" and the weekly briefing's "이번주 검증" link.
 *
 * Design notes:
 *   - Date grouping uses relative-Korean buckets so the screen reads
 *     like a personal record book: 오늘 / 어제 / 이번 주 / 이번 달 / ISO.
 *   - Each row reuses FactTypeBadge + FactTypeStrip from FactCard so the
 *     [CLAIM] / [MEASUREMENT] visual parity with RECALL / DECIDE is
 *     preserved verbatim — no fork of the badge styling.
 *   - Entity references are clickable: clicking the subject deep-links
 *     into RECALL with `?q=<entity name>`, which is the easiest
 *     "trail-of-thought" path between the two surfaces.
 *   - Empty state CTAs the user toward /pending so a fresh user sees
 *     "no facts yet — go validate something" instead of a blank page.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FactTypeBadge, FactTypeStrip } from './FactCard';
import { fetchLedger as apiFetchLedger } from '@/lib/api';
import { useStateChange } from '@/lib/sync';
import { predicateLabel } from '@/lib/predicateLabels';
import type { LedgerItem } from '@/lib/types';

interface Props {
  spaceId: string;
}

type FactTypeKey = 'action' | 'claim' | 'measurement';

const FACT_TYPE_LABELS: Record<FactTypeKey, string> = {
  action: '행동',
  claim: '발언',
  measurement: '수치',
};

const FACT_TYPE_ORDER: FactTypeKey[] = ['action', 'claim', 'measurement'];

const PAGE_SIZE = 20;

// Subject / object surface resolver — mirrors RecallView's resolveLabel
// so a UUID/obj-N renders as the human-readable name when the server
// supplied one, and falls back to a "(미해석)" marker otherwise.
const OBJECT_REF_PATTERN =
  /^(?:obj-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function resolveLabel(
  value: string | undefined,
  label: string | null | undefined,
): string {
  if (label) return label;
  if (!value) return '—';
  if (OBJECT_REF_PATTERN.test(value)) return `${value} (미해석)`;
  return value;
}

// Pipe-claim artefact detection — same shape RecallView uses to surface
// the "(재구성됨)" marker when the stored claim was overwritten by the
// Decide-side regenerator. Here we just want to know whether to show
// the raw claim or the reconstructed SPO triple as the title.
const PIPE_CLAIM_RE = /^[^|]+ \| [^|]+ \| [^|]+$/;

function isReconstructedClaim(claim: string | null | undefined): boolean {
  if (!claim) return false;
  return PIPE_CLAIM_RE.test(claim.trim());
}

// Relative-Korean time formatter. Visible string on the card; the full
// timestamp is preserved in the `title` attribute + `<time dateTime>`
// so the user can hover for the exact validated_at.
export function relativeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diffMs = now.getTime() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return '방금 전';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}일 전`;
  const weeks = Math.round(day / 7);
  if (weeks < 5) return `${weeks}주 전`;
  return d.toLocaleDateString('ko-KR');
}

// Date-bucket grouper — collapses a flat fact list into a map keyed by
// relative-Korean labels. Bucket priority: 오늘 first, then 어제, 이번 주,
// 이번 달, then ISO date strings (YYYY-MM-DD) descending.
const BUCKET_PRIORITY: Record<string, number> = {
  오늘: 0,
  어제: 1,
  '이번 주': 2,
  '이번 달': 3,
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function bucketLabel(
  validatedAt: string,
  now = new Date(),
): string {
  const d = new Date(validatedAt);
  const today = startOfDay(now);
  const that = startOfDay(d);
  const diffDays = Math.round(
    (today.getTime() - that.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays <= 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays < 7) return '이번 주';
  // Same calendar month → 이번 달.
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth()
  ) {
    return '이번 달';
  }
  // ISO YYYY-MM-DD using local-time fields so the visible bucket matches
  // the user's calendar, not UTC midnight.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface Group {
  label: string;
  items: LedgerItem[];
}

export function groupByDate(facts: LedgerItem[], now = new Date()): Group[] {
  const groups = new Map<string, LedgerItem[]>();
  for (const fact of facts) {
    const label = bucketLabel(fact.validated_at, now);
    const arr = groups.get(label);
    if (arr) {
      arr.push(fact);
    } else {
      groups.set(label, [fact]);
    }
  }
  const labels = Array.from(groups.keys());
  labels.sort((a, b) => {
    const pa = BUCKET_PRIORITY[a];
    const pb = BUCKET_PRIORITY[b];
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    // Both are ISO date strings — sort descending so newer dates surface first.
    return a < b ? 1 : a > b ? -1 : 0;
  });
  return labels.map((label) => ({ label, items: groups.get(label) ?? [] }));
}

interface LedgerCardProps {
  fact: LedgerItem;
}

function LedgerCard({ fact }: LedgerCardProps) {
  const subjectDisplay = resolveLabel(fact.subject_uid, fact.subject_label);
  const objectDisplay = resolveLabel(fact.object_value, fact.object_label);
  const isObjectEntity = !!fact.object_label;
  const claimText = (fact.claim ?? '').trim();
  const reconstructed = !claimText || isReconstructedClaim(claimText);
  const titleText = reconstructed
    ? `${subjectDisplay} → ${predicateLabel(fact.predicate, fact.predicate_label)} → ${objectDisplay}`
    : claimText;
  const sourceUrls = (fact.source_uids ?? []).filter((s) =>
    s.startsWith('http'),
  );
  // Deep-link target for entity refs — RECALL is the easiest stop on
  // the entity trail since it has a built-in query box.
  const subjectHref = `/recall?q=${encodeURIComponent(
    fact.subject_label || fact.subject_uid,
  )}`;
  const objectHref = isObjectEntity
    ? `/recall?q=${encodeURIComponent(fact.object_label || fact.object_value)}`
    : null;
  const validatedAbsolute = new Date(fact.validated_at).toLocaleString();
  return (
    <article
      data-testid={`ledger-fact-${fact.fact_uid}`}
      className="rounded-lg border border-border-subtle bg-bg-card p-4 mb-3"
    >
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <FactTypeBadge factType={fact.fact_type} factUid={fact.fact_uid} />
        </div>
        <time
          className="font-mono text-xxs text-text-muted"
          dateTime={fact.validated_at}
          title={validatedAbsolute}
        >
          {relativeTime(fact.validated_at)}
        </time>
      </header>
      <p
        className="text-base mb-3"
        lang="ko"
        data-testid={`ledger-fact-${fact.fact_uid}-title`}
      >
        {titleText}
        {reconstructed && (
          <span
            className="ml-2 italic text-xxs font-mono text-text-muted"
            title="원문이 보존되지 않은 편집 사실 — 주체·술어·객체로 재구성"
          >
            (재구성됨)
          </span>
        )}
      </p>
      <FactTypeStrip fact={fact} factUid={fact.fact_uid} lang="kr" />
      <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-2 mb-3">
        <div>
          <dt className="opacity-60">subject</dt>
          <dd>
            <Link
              href={subjectHref}
              data-testid={`ledger-fact-${fact.fact_uid}-subject-link`}
              className="text-accent-cool hover:underline"
            >
              {subjectDisplay}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="opacity-60">predicate</dt>
          <dd>{predicateLabel(fact.predicate, fact.predicate_label)}</dd>
        </div>
        <div>
          <dt className="opacity-60">object</dt>
          <dd>
            {objectHref ? (
              <Link
                href={objectHref}
                data-testid={`ledger-fact-${fact.fact_uid}-object-link`}
                className="text-accent-cool hover:underline"
              >
                {objectDisplay}
              </Link>
            ) : (
              <span>{objectDisplay}</span>
            )}
          </dd>
        </div>
      </dl>
      {sourceUrls.length > 0 && (
        <footer className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xxs text-text-muted">
          <span>sources:</span>
          {sourceUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-accent-cool underline"
            >
              {url.replace(/^https?:\/\//, '').slice(0, 50)}
            </a>
          ))}
        </footer>
      )}
    </article>
  );
}

export function LedgerView({ spaceId }: Props) {
  const [facts, setFacts] = useState<LedgerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FactTypeKey | null>(null);
  // Re-entrancy guard for the load-more button: a quick double-click
  // should not fire two overlapping fetches.
  const fetchSeq = useRef(0);

  const load = useCallback(
    async (factType: FactTypeKey | null) => {
      const seq = ++fetchSeq.current;
      setLoading(true);
      setError(null);
      try {
        const resp = await apiFetchLedger(spaceId, {
          limit: PAGE_SIZE,
          offset: 0,
          factType,
        });
        if (seq !== fetchSeq.current) return; // stale response
        setFacts(resp.facts);
        setTotal(resp.total);
      } catch (e) {
        if (seq !== fetchSeq.current) return;
        const msg = e instanceof Error ? e.message : 'failed to load ledger';
        setError(msg);
        setFacts([]);
        setTotal(0);
      } finally {
        if (seq === fetchSeq.current) {
          setLoading(false);
        }
      }
    },
    [spaceId],
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  useStateChange(
    useCallback(
      (e) => {
        // fix/h1-state-sync-autorefresh: PO trace. The LEDGER reads the
        // same ES index as the home brief; an out-of-sync LEDGER usually
        // means the event arrived but the spaceId-scoped load() pulled
        // stale data because ES hadn't indexed yet. Producers now wait
        // 200ms; if you still see this then no fresh count, the indexer
        // is slower than that and `refresh_interval` needs tuning.
        // eslint-disable-next-line no-console
        console.debug('[LedgerView] sync event — reload', e.reason);
        void load(filter);
      },
      [load, filter],
    ),
  );

  const onFilterChange = (next: FactTypeKey | null) => {
    setFilter(next);
  };

  const onLoadMore = async () => {
    if (loadingMore) return;
    const seq = ++fetchSeq.current;
    setLoadingMore(true);
    try {
      const resp = await apiFetchLedger(spaceId, {
        limit: PAGE_SIZE,
        offset: facts.length,
        factType: filter,
      });
      if (seq !== fetchSeq.current) return;
      setFacts((cur) => [...cur, ...resp.facts]);
      setTotal(resp.total);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      const msg = e instanceof Error ? e.message : 'failed to load more';
      setError(msg);
    } finally {
      if (seq === fetchSeq.current) {
        setLoadingMore(false);
      }
    }
  };

  const groups = useMemo(() => groupByDate(facts), [facts]);
  const hasMore = facts.length < total;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8" data-testid="ledger-view">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">기록 (Ledger)</h1>
        <p className="text-sm text-text-secondary">
          최근 검증한 사실 — 시간순
        </p>
      </header>

      <div
        role="group"
        aria-label="fact type filter"
        className="flex flex-wrap items-center gap-2 mb-5"
      >
        <button
          type="button"
          data-testid="ledger-filter-chip-all"
          data-active={filter === null ? 'true' : 'false'}
          aria-pressed={filter === null}
          onClick={() => onFilterChange(null)}
          className={[
            'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            filter === null
              ? 'border-accent-cool/70 bg-accent-cool/15 text-accent-cool'
              : 'border-border-subtle bg-bg-card text-text-secondary hover:bg-bg-elevated/60',
          ].join(' ')}
        >
          전체
        </button>
        {FACT_TYPE_ORDER.map((kind) => {
          const active = filter === kind;
          return (
            <button
              key={kind}
              type="button"
              data-testid={`ledger-filter-chip-${kind}`}
              data-active={active ? 'true' : 'false'}
              aria-pressed={active}
              onClick={() => onFilterChange(active ? null : kind)}
              className={[
                'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-accent-cool/70 bg-accent-cool/15 text-accent-cool'
                  : 'border-border-subtle bg-bg-card text-text-secondary hover:bg-bg-elevated/60',
              ].join(' ')}
            >
              {FACT_TYPE_LABELS[kind]}
            </button>
          );
        })}
      </div>

      {loading && facts.length === 0 && (
        <p
          data-testid="ledger-loading"
          className="text-sm text-text-muted font-mono"
        >
          불러오는 중…
        </p>
      )}

      {error && (
        <p
          data-testid="ledger-error"
          className="text-sm text-accent-error font-mono mb-3"
        >
          {error}
        </p>
      )}

      {!loading && total === 0 && !error && (
        <section
          data-testid="ledger-empty-state"
          className="rounded-lg border border-border-subtle bg-bg-card p-6 text-center"
        >
          <p className="text-base mb-3" lang="ko">
            아직 검증한 사실이 없습니다.
          </p>
          <Link
            href="/pending"
            className="inline-block text-sm text-accent-cool hover:underline"
          >
            검증 큐로 이동 →
          </Link>
        </section>
      )}

      {!loading && total > 0 && (
        <div data-testid="ledger-groups">
          {groups.map((group) => (
            <section
              key={group.label}
              data-testid={`ledger-group-${group.label}`}
              className="mb-6"
            >
              <h2 className="text-xxs uppercase tracking-wider text-text-muted font-mono mb-2">
                {group.label}
              </h2>
              {group.items.map((fact) => (
                <LedgerCard key={fact.fact_uid} fact={fact} />
              ))}
            </section>
          ))}
        </div>
      )}

      {!loading && hasMore && (
        <div className="flex justify-center mt-4">
          <button
            type="button"
            data-testid="ledger-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded-md border border-border-subtle bg-bg-card px-4 py-2 text-sm text-text-secondary hover:bg-bg-elevated/60 disabled:opacity-60"
          >
            {loadingMore ? '불러오는 중…' : '더 보기'}
          </button>
        </div>
      )}
    </main>
  );
}
