'use client';

/**
 * RecallView — DR-089 dogfood thin slice + B-40 polish.
 *
 * What this component is:
 *   - Single search input + a signature line + a list of fact cards.
 *   - Calls GET /api/spaces/{sid}/recall on submit.
 *   - Renders ONLY what the backend returned. The empty signature
 *     ("검증된 사실이 없습니다") is rendered verbatim; we do not pad,
 *     paraphrase, or augment. Zero-hallucination is the value prop.
 *
 * B-40 additions:
 *   · resolveLabel — match FactCard's resolver so a UUID/obj-N subject
 *     becomes "SpaceX" not "dee1ba2c-...". The backend now emits
 *     subject_label / object_label, so this is just rendering them.
 *   · Sort facts by score DESC (embedding hits first, entity_link
 *     expansion second).
 *   · A small badge labels each card as either "유사도 매치" or
 *     "엔티티 연결". The recall threshold is announced once above
 *     the result list so the user understands the filtering policy.
 */

import { useMemo, useState } from 'react';
import { ActionButton } from './ActionButton';
import { recall as apiRecall, ApiError } from '@/lib/api';
import type { RecallFact, RecallResponse } from '@/lib/types';

interface Props {
  spaceId: string;
}

const OBJECT_REF_PATTERN = /^(?:obj-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function resolveLabel(value: string | undefined, label: string | null | undefined): string {
  // Server-resolved label always wins.
  if (label) return label;
  if (!value) return '—';
  // Backend signalled this looks like an entity uid but no label was
  // found — surface a "(미해석)" marker matching FactCard's behaviour
  // so the user sees the same recovery affordance everywhere.
  if (OBJECT_REF_PATTERN.test(value)) return `${value} (미해석)`;
  return value;
}

function MatchKindBadge({ kind }: { kind: 'embedding' | 'entity_link' | undefined }) {
  if (kind === 'entity_link') {
    return (
      <span
        data-testid="recall-badge-entity-link"
        className="rounded-full bg-accent-warm/10 text-accent-warm border border-accent-warm/40 px-2 py-0.5 text-xxs font-mono"
        title="이 fact 는 다른 매치된 fact 의 entity 와 연결되어 나타났습니다"
      >
        🔗 엔티티 연결
      </span>
    );
  }
  return (
    <span
      data-testid="recall-badge-embedding"
      className="rounded-full bg-accent-cool/10 text-accent-cool border border-accent-cool/40 px-2 py-0.5 text-xxs font-mono"
      title="질의 임베딩과 fact 임베딩이 직접 유사"
    >
      🔍 유사도 매치
    </span>
  );
}

function RecallFactCard({ fact }: { fact: RecallFact }) {
  const sourceUrls = fact.source_uids.filter((s) => s.startsWith('http'));
  const subjectDisplay = resolveLabel(fact.subject_uid, fact.subject_label);
  const objectDisplay = resolveLabel(fact.object_value, fact.object_label);
  return (
    <article
      data-testid={`recall-fact-${fact.fact_uid}`}
      data-match-kind={fact.match_kind ?? 'embedding'}
      className="rounded-lg border border-border-subtle bg-bg-card p-4 mb-3"
    >
      <header className="flex items-center justify-between mb-2">
        <MatchKindBadge kind={fact.match_kind} />
        <span
          className="font-mono text-xxs text-text-muted"
          title="kNN cosine score"
          data-testid={`recall-fact-${fact.fact_uid}-score`}
        >
          score {fact.score.toFixed(2)}
        </span>
      </header>
      <p className="text-base mb-3" lang="ko">
        {fact.claim}
      </p>
      <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-2 mb-3">
        <div>
          <dt className="opacity-60">subject</dt>
          <dd data-testid={`recall-fact-${fact.fact_uid}-subject`}>{subjectDisplay}</dd>
        </div>
        <div>
          <dt className="opacity-60">predicate</dt>
          <dd>{fact.predicate}</dd>
        </div>
        <div>
          <dt className="opacity-60">object</dt>
          <dd data-testid={`recall-fact-${fact.fact_uid}-object`}>{objectDisplay}</dd>
        </div>
      </dl>
      <footer className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xxs text-text-muted">
        <span>
          validated{' '}
          <time dateTime={fact.validated_at}>
            {new Date(fact.validated_at).toLocaleString()}
          </time>
        </span>
        {sourceUrls.length > 0 && (
          <span className="flex flex-wrap gap-2">
            sources:
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
          </span>
        )}
      </footer>
    </article>
  );
}

function sortFacts(facts: RecallFact[]): RecallFact[] {
  // Score DESC. The backend already returns embedding matches first
  // and entity_link expansion last, but explicit sort guards against
  // the entity-link facts (score 0) sneaking ahead if the response
  // shape ever changes.
  return [...facts].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function RecallView({ spaceId }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RecallResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedFacts = useMemo(
    () => (result ? sortFacts(result.facts) : []),
    [result],
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiRecall(spaceId, query.trim());
      setResult(r);
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-light">Recall</h1>
        <p className="text-sm text-text-secondary">
          그래프 안의 사실만 답합니다. 그래프 밖은 답하지 않습니다.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="질문을 입력하세요 (Ko/En)"
          className="flex-1 rounded-md border border-border-subtle bg-bg-card p-2 text-sm focus:outline-none focus:border-accent-cool"
          aria-label="recall query"
        />
        <ActionButton type="submit" variant="primary" disabled={busy || !query.trim()}>
          {busy ? '검색 중…' : 'Recall'}
        </ActionButton>
      </form>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-accent-error/40 bg-accent-error/5 p-3 text-sm text-accent-error"
        >
          {error}
        </p>
      )}

      {result && (
        <section aria-label="recall result">
          <p
            data-testid="recall-signature"
            className="text-sm text-text-primary mb-2 font-medium"
          >
            {result.signature}
          </p>
          {sortedFacts.length > 0 && (
            <p
              data-testid="recall-threshold-note"
              className="text-xxs text-text-muted mb-4 font-mono"
            >
              관련도 0.72 이상 매치만 표시 · 점수 내림차순 정렬
              {result.expanded_count && result.expanded_count > 0
                ? ` · 엔티티 연결로 추가된 ${result.expanded_count}건 포함`
                : ''}
            </p>
          )}
          {sortedFacts.map((f) => (
            <RecallFactCard key={f.fact_uid} fact={f} />
          ))}
        </section>
      )}
    </main>
  );
}
