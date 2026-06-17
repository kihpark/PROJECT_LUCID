'use client';

/**
 * RecallView — DR-089 dogfood thin slice.
 *
 * What this component is:
 *   - Single search input + a signature line + a list of FactCards.
 *   - Calls GET /api/spaces/{sid}/recall on submit.
 *   - Renders ONLY what the backend returned. The empty signature
 *     ("검증된 사실이 없습니다") is rendered verbatim; we do not pad,
 *     paraphrase, or augment. Zero-hallucination is the value prop.
 *
 * What this component is NOT:
 *   - Stellar visualisation, entity briefs, reasoning, voice. Those
 *     are explicit OUT-of-scope per B-25 instructions.
 */

import { useState } from 'react';
import { ActionButton } from './ActionButton';
import { recall as apiRecall, ApiError } from '@/lib/api';
import type { RecallFact, RecallResponse } from '@/lib/types';

interface Props {
  spaceId: string;
}

function RecallFactCard({ fact }: { fact: RecallFact }) {
  const sourceUrls = fact.source_uids.filter((s) => s.startsWith('http'));
  return (
    <article
      data-testid={`recall-fact-${fact.fact_uid}`}
      className="rounded-lg border border-border-subtle bg-bg-card p-4 mb-3"
    >
      <p className="text-base mb-3" lang="ko">
        {fact.claim}
      </p>
      <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-2 mb-3">
        <div>
          <dt className="opacity-60">subject</dt>
          <dd>{fact.subject_uid}</dd>
        </div>
        <div>
          <dt className="opacity-60">predicate</dt>
          <dd>{fact.predicate}</dd>
        </div>
        <div>
          <dt className="opacity-60">object</dt>
          <dd>{fact.object_value}</dd>
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
        <span className="font-mono" title="kNN cosine score">
          score {fact.score.toFixed(2)}
        </span>
      </footer>
    </article>
  );
}

export function RecallView({ spaceId }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RecallResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          {busy ? '...' : 'Recall'}
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
            className="text-sm text-text-primary mb-4 font-medium"
          >
            {result.signature}
          </p>
          {result.facts.map((f) => (
            <RecallFactCard key={f.fact_uid} fact={f} />
          ))}
        </section>
      )}
    </main>
  );
}
