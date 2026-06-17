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
import type {
  EntityBrief,
  EntityBriefGroup,
  EntityFactRef,
  EntityFacetItem,
  PredicateFacetItem,
  RecallFact,
  RecallFacets,
  RecallResponse,
} from '@/lib/types';

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

function BriefGroup({
  group, role,
}: { group: EntityBriefGroup; role: 'subject' | 'object' }) {
  return (
    <details
      data-testid={`brief-group-${role}-${group.predicate}`}
      className="rounded border border-border-subtle bg-bg-card mb-2"
      open
    >
      <summary className="cursor-pointer px-3 py-2 text-sm flex items-baseline gap-2">
        <code className="font-mono text-accent-cool">{group.predicate}</code>
        <span className="text-text-muted text-xxs">({group.facts.length})</span>
      </summary>
      <ul className="px-4 pb-3 space-y-1">
        {group.facts.map((f) => (
          <li key={f.fact_uid} className="text-sm" data-testid={`brief-fact-${f.fact_uid}`}>
            <span lang="ko">{f.claim}</span>
            {f.other_label && (
              <span className="ml-2 text-xxs font-mono text-text-muted">
                ↔ {f.other_label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}


function EntityBriefPanel({ brief }: { brief: EntityBrief }) {
  if (brief.total_facts === 0) {
    return (
      <section
        aria-label="entity brief"
        data-testid="entity-brief"
        className="rounded-lg border border-accent-cool/40 bg-accent-cool/5 p-4 mb-6"
      >
        <h2 className="text-lg font-medium mb-1">
          <span data-testid="brief-entity-name">{brief.entity_name}</span>
          {brief.entity_class && (
            <span className="ml-2 text-xxs font-mono text-text-muted">
              {brief.entity_class}
            </span>
          )}
        </h2>
        <p className="text-sm text-text-muted">
          이 엔티티에 대한 검증된 사실이 없습니다.
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="entity brief"
      data-testid="entity-brief"
      className="rounded-lg border border-accent-cool/40 bg-accent-cool/5 p-4 mb-6"
    >
      <header className="mb-3">
        <h2 className="text-lg font-medium">
          <span data-testid="brief-entity-name">{brief.entity_name}</span>
          {brief.entity_class && (
            <span className="ml-2 text-xxs font-mono text-text-muted">
              {brief.entity_class}
            </span>
          )}
        </h2>
        <p className="text-xxs text-text-muted font-mono">
          {brief.total_facts}개 검증 사실 · 술어별 그룹 · 생성 0
        </p>
      </header>
      {brief.as_subject.length > 0 && (
        <div className="mb-3" data-testid="brief-as-subject">
          <h3 className="text-xs font-medium text-text-secondary mb-2">
            주어로서 ({brief.as_subject.reduce((n, g) => n + g.facts.length, 0)})
          </h3>
          {brief.as_subject.map((g) => (
            <BriefGroup key={`s-${g.predicate}`} group={g} role="subject" />
          ))}
        </div>
      )}
      {brief.as_object.length > 0 && (
        <div data-testid="brief-as-object">
          <h3 className="text-xs font-medium text-text-secondary mb-2">
            목적어로서 ({brief.as_object.reduce((n, g) => n + g.facts.length, 0)})
          </h3>
          {brief.as_object.map((g) => (
            <BriefGroup key={`o-${g.predicate}`} group={g} role="object" />
          ))}
        </div>
      )}
    </section>
  );
}


const BUCKET_LABELS: Record<'organization' | 'person' | 'place' | 'other', string> = {
  organization: '조직',
  person: '사람',
  place: '장소',
  other: '기타',
};

interface FacetBarProps {
  item: EntityFacetItem | PredicateFacetItem;
  active: boolean;
  maxCount: number;
  onClick?: () => void;
  testId: string;
  uid?: string;
}

function FacetBar({ item, active, maxCount, onClick, testId, uid }: FacetBarProps) {
  const widthPct = maxCount > 0 ? Math.max(8, Math.round((item.count / maxCount) * 100)) : 0;
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      data-uid={uid}
      onClick={onClick}
      disabled={!onClick}
      className={[
        'w-full text-left px-2 py-1.5 rounded-sm transition-colors text-xs flex items-center gap-2',
        active
          ? 'bg-accent-cool/15 border border-accent-cool/60'
          : 'hover:bg-bg-elevated/60 border border-transparent',
        onClick ? 'cursor-pointer' : 'cursor-default',
      ].join(' ')}
    >
      <span
        className={[
          'block h-2 rounded-sm shrink-0',
          active ? 'bg-accent-cool' : 'bg-accent-cool/40',
        ].join(' ')}
        style={{ width: `${widthPct}%`, maxWidth: '60%' }}
      />
      <span className="flex-1 truncate" title={item.name}>{item.name}</span>
      <span className="font-mono text-xxs text-text-muted shrink-0">{item.count}</span>
    </button>
  );
}

interface FacetPanelProps {
  facets: RecallFacets | undefined;
  activeEntityUids: string[];
  onToggleEntity: (uid: string) => void;
}

function FacetPanel({ facets, activeEntityUids, onToggleEntity }: FacetPanelProps) {
  const entities = facets?.entities;
  const predicates = facets?.predicates ?? [];
  const activeSet = new Set(activeEntityUids);

  const buckets = entities
    ? (['organization', 'person', 'place', 'other'] as const)
    : [];

  const allEntityCounts = entities
    ? Object.values(entities).flatMap((arr) => arr.map((e) => e.count))
    : [];
  const maxEntityCount = allEntityCounts.length > 0 ? Math.max(...allEntityCounts) : 0;
  const maxPredicateCount = predicates.length > 0 ? Math.max(...predicates.map((p) => p.count)) : 0;

  return (
    <aside
      aria-label="facets"
      data-testid="facet-panel"
      className="hidden lg:block sticky top-4 self-start w-64 shrink-0"
    >
      <h2 className="text-xxs uppercase tracking-wider text-text-muted mb-3 font-mono">
        Entities
      </h2>
      {buckets.map((bucket) => {
        const items = entities ? entities[bucket] : [];
        return (
          <div
            key={bucket}
            data-testid={`facet-bucket-${bucket}`}
            className="mb-4"
          >
            <h3 className="text-xs font-medium text-text-secondary mb-1">
              {BUCKET_LABELS[bucket]} ({items.length})
            </h3>
            {items.length === 0 ? (
              <p className="text-xxs text-text-muted px-2 py-1">(없음)</p>
            ) : (
              <ul className="space-y-1">
                {items.map((item) => (
                  <li key={item.uid}>
                    <FacetBar
                      item={item}
                      active={activeSet.has(item.uid)}
                      maxCount={maxEntityCount}
                      onClick={() => onToggleEntity(item.uid)}
                      testId={`facet-entity-${item.uid}`}
                      uid={item.uid}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <h2 className="text-xxs uppercase tracking-wider text-text-muted mb-3 mt-6 font-mono">
        Predicates
      </h2>
      {predicates.length === 0 ? (
        <p className="text-xxs text-text-muted px-2 py-1">(없음)</p>
      ) : (
        <ul data-testid="facet-predicates" className="space-y-1">
          {predicates.map((p) => (
            <li key={p.name}>
              <FacetBar
                item={p}
                active={false}
                maxCount={maxPredicateCount}
                testId={`facet-predicate-${p.name}`}
              />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

interface ActiveFilterChipsProps {
  entities: { uid: string; name: string; bucket: string }[];
  onRemove: (uid: string) => void;
  onClearAll: () => void;
}

function ActiveFilterChips({ entities, onRemove, onClearAll }: ActiveFilterChipsProps) {
  if (entities.length === 0) return null;
  return (
    <div
      data-testid="active-filter-chips"
      className="flex flex-wrap items-center gap-2 mb-4"
    >
      {entities.map((e) => (
        <span
          key={e.uid}
          data-testid={`filter-chip-${e.uid}`}
          className="inline-flex items-center gap-1 rounded-full bg-accent-cool/15 border border-accent-cool/60 px-2 py-0.5 text-xs"
        >
          <span className="text-xxs text-text-muted">{e.bucket}:</span>
          <span>{e.name}</span>
          <button
            type="button"
            aria-label={`Remove filter ${e.name}`}
            data-testid={`filter-chip-${e.uid}-remove`}
            onClick={() => onRemove(e.uid)}
            className="ml-1 text-text-muted hover:text-accent-error font-mono"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        data-testid="filter-clear-all"
        onClick={onClearAll}
        className="text-xxs text-text-muted hover:text-text-primary font-mono underline"
      >
        모두 지우기
      </button>
    </div>
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
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [activeEntities, setActiveEntities] = useState<string[]>([]);
  const [result, setResult] = useState<RecallResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedFacts = useMemo(
    () => (result ? sortFacts(result.facts) : []),
    [result],
  );

  // Build the "active filter chips" view: walk the current facets to
  // find the name + bucket for each active uid (the backend already
  // resolved labels). When the facets haven't loaded yet (very first
  // request) we still render uids so the user can remove them.
  const activeFilterDetails = useMemo(() => {
    if (activeEntities.length === 0) return [];
    const entities = result?.facets?.entities;
    const lookup = new Map<string, { name: string; bucket: string }>();
    if (entities) {
      (['organization', 'person', 'place', 'other'] as const).forEach((b) => {
        for (const e of entities[b]) {
          lookup.set(e.uid, { name: e.name, bucket: BUCKET_LABELS[b] });
        }
      });
    }
    return activeEntities.map((uid) => {
      const m = lookup.get(uid);
      return {
        uid,
        name: m?.name ?? uid,
        bucket: m?.bucket ?? '엔티티',
      };
    });
  }, [activeEntities, result]);

  const runRecall = async (q: string, entities: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRecall(spaceId, q, { entity: entities });
      setResult(r);
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    const q = query.trim();
    setSubmittedQuery(q);
    // Submitting a NEW query resets the drill-down stack — the user
    // is starting fresh; the previously selected entities don't carry
    // over because they refer to a different result set.
    setActiveEntities([]);
    await runRecall(q, []);
  };

  const onToggleEntity = (uid: string) => {
    if (!submittedQuery) return;
    setActiveEntities((prev) => {
      const isActive = prev.includes(uid);
      const next = isActive ? prev.filter((u) => u !== uid) : [...prev, uid];
      void runRecall(submittedQuery, next);
      return next;
    });
  };

  const onRemoveChip = (uid: string) => {
    if (!submittedQuery) return;
    setActiveEntities((prev) => {
      const next = prev.filter((u) => u !== uid);
      void runRecall(submittedQuery, next);
      return next;
    });
  };

  const onClearAll = () => {
    if (!submittedQuery) return;
    setActiveEntities([]);
    void runRecall(submittedQuery, []);
  };

  return (
    <div className="flex gap-4 px-4 py-6 mx-auto max-w-7xl">
      <aside
        aria-label="search controls placeholder"
        data-testid="left-rail-placeholder"
        className="hidden lg:block w-48 shrink-0 sticky top-4 self-start text-xxs text-text-muted font-mono"
      >
        <p className="opacity-50">검색 컨트롤 (B-50)</p>
      </aside>

      <main className="flex-1 min-w-0">
        <header className="mb-6">
          <h1 className="text-2xl font-light">Recall</h1>
          <p className="text-sm text-text-secondary">
            그래프 안의 사실만 답합니다. 그래프 밖은 답하지 않습니다.
          </p>
        </header>

        <form onSubmit={onSubmit} className="flex gap-2 mb-4">
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

        <ActiveFilterChips
          entities={activeFilterDetails}
          onRemove={onRemoveChip}
          onClearAll={onClearAll}
        />

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
            {result.entity_brief && (
              <EntityBriefPanel brief={result.entity_brief} />
            )}
            {sortedFacts.length > 0 && (
              <>
                <p
                  data-testid="recall-threshold-note"
                  className="text-xxs text-text-muted mb-4 font-mono"
                >
                  관련도 0.72 이상 매치만 표시 · 점수 내림차순 정렬
                  {result.expanded_count && result.expanded_count > 0
                    ? ` · 엔티티 연결로 추가된 ${result.expanded_count}건 포함`
                    : ''}
                </p>
                {sortedFacts.map((f) => (
                  <RecallFactCard key={f.fact_uid} fact={f} />
                ))}
              </>
            )}
          </section>
        )}
      </main>

      <FacetPanel
        facets={result?.facets}
        activeEntityUids={activeEntities}
        onToggleEntity={onToggleEntity}
      />
    </div>
  );
}
