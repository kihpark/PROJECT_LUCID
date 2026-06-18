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
import {
  recall as apiRecall,
  ApiError,
  detachSource as apiDetachSource,
  getFactDetail as apiGetFactDetail,
  restoreFact as apiRestoreFact,
  retractFact as apiRetractFact,
} from '@/lib/api';
import type {
  EntityBrief,
  EntityBriefGroup,
  EntityFacetItem,
  FactDetailResponse,
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

function RecallFactCard({
  fact, onOpenDetail,
}: { fact: RecallFact; onOpenDetail?: (factUid: string) => void }) {
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
      {onOpenDetail ? (
        <button
          type="button"
          data-testid={`recall-fact-${fact.fact_uid}-open-detail`}
          onClick={() => onOpenDetail(fact.fact_uid)}
          className="text-left text-base mb-3 hover:underline"
          lang="ko"
        >
          {fact.claim}
        </button>
      ) : (
        <p className="text-base mb-3" lang="ko">{fact.claim}</p>
      )}
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

// ---------------------------------------------------------------------------
// B-48b — fact detail panel (right-rail swap)
// ---------------------------------------------------------------------------

interface FactDetailPanelProps {
  detail: FactDetailResponse;
  onClose: () => void;
  onDetachSource: (sourceUid: string) => Promise<void>;
  onRetract: () => Promise<void>;
  onRestore: () => Promise<void>;
  busy: boolean;
}

function FactDetailPanel({
  detail, onClose, onDetachSource, onRetract, onRestore, busy,
}: FactDetailPanelProps) {
  const { fact, entities, sources } = detail;
  const retracted = !!fact.retracted_at;
  const trusted = sources.length >= 2;
  const subject = entities.find((e) => e.role === 'subject');
  const object = entities.find((e) => e.role === 'object');
  return (
    <aside
      aria-label="fact detail"
      data-testid="fact-detail-panel"
      data-retracted={retracted ? 'true' : 'false'}
      className="hidden lg:block sticky top-4 self-start w-72 shrink-0"
    >
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-xxs uppercase tracking-wider text-text-muted font-mono">
          Fact 상세
        </h2>
        <button
          type="button"
          data-testid="fact-detail-close"
          onClick={onClose}
          aria-label="close fact detail"
          className="text-xxs text-text-muted hover:text-text-primary font-mono"
        >
          ✕ 닫기
        </button>
      </header>

      <section
        className={[
          'rounded-lg border p-3 mb-3',
          retracted
            ? 'border-accent-error/40 bg-accent-error/5'
            : 'border-border-subtle bg-bg-card',
        ].join(' ')}
      >
        {retracted && (
          <p
            data-testid="fact-detail-retracted-banner"
            className="text-xxs text-accent-error mb-2 font-mono"
          >
            철회된 사실 · {new Date(fact.retracted_at!).toLocaleString()}
          </p>
        )}
        <p
          data-testid="fact-detail-claim"
          className="text-sm mb-2 leading-snug"
          lang="ko"
        >
          {fact.claim}
        </p>
        <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-1 mb-2">
          <div>
            <dt className="opacity-60">subject</dt>
            <dd data-testid="fact-detail-subject">
              {subject?.name ?? fact.subject_label ?? fact.subject_uid}
              {subject?.class && (
                <span className="ml-1 text-xxs opacity-60">({subject.class})</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="opacity-60">predicate</dt>
            <dd>{fact.predicate}</dd>
          </div>
          <div>
            <dt className="opacity-60">object</dt>
            <dd data-testid="fact-detail-object">
              {object?.name ?? fact.object_label ?? fact.object_value}
              {object?.class && (
                <span className="ml-1 text-xxs opacity-60">({object.class})</span>
              )}
            </dd>
          </div>
        </dl>
        {(subject?.aliases?.length ?? 0) > 0 && (
          <p className="text-xxs text-text-muted font-mono">
            alias: {subject!.aliases!.join(', ')}
          </p>
        )}
        <p className="text-xxs text-text-muted font-mono">
          validated{' '}
          <time dateTime={fact.validated_at}>
            {new Date(fact.validated_at).toLocaleString()}
          </time>
        </p>
      </section>

      <section className="mb-3">
        <header className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium">출처 ({sources.length})</h3>
          {trusted && (
            <span
              data-testid="fact-detail-trust-badge"
              className="rounded-full bg-accent-cool/15 text-accent-cool border border-accent-cool/40 px-2 py-0.5 text-xxs font-mono"
              title="검증된 출처가 둘 이상"
            >
              ✓ 검증된 출처 {sources.length}건
            </span>
          )}
        </header>
        {sources.length === 0 ? (
          <p className="text-xxs text-text-muted py-1">(출처 없음)</p>
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => (
              <li
                key={s.source_uid}
                data-testid={`fact-detail-source-${s.source_uid}`}
                className="rounded border border-border-subtle bg-bg-card p-2 text-xxs"
              >
                <div className="flex justify-between gap-2 mb-1">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-cool underline truncate"
                    title={s.url}
                  >
                    {s.domain || s.url.replace(/^https?:\/\//, '').slice(0, 40)}
                  </a>
                  <button
                    type="button"
                    data-testid={`fact-detail-detach-${s.source_uid}`}
                    onClick={() => onDetachSource(s.source_uid)}
                    disabled={busy}
                    className="text-text-muted hover:text-accent-error font-mono shrink-0"
                  >
                    이 출처만 떼기
                  </button>
                </div>
                {s.captured_at && (
                  <p className="text-text-muted">
                    captured{' '}
                    <time dateTime={s.captured_at}>
                      {new Date(s.captured_at).toLocaleString()}
                    </time>
                  </p>
                )}
                {s.snapshot_available && (
                  <p className="text-text-muted opacity-70">스냅샷 보존</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="flex justify-end">
        {retracted ? (
          <button
            type="button"
            data-testid="fact-detail-restore"
            onClick={onRestore}
            disabled={busy}
            className="rounded border border-accent-cool/40 bg-accent-cool/10 text-accent-cool px-3 py-1 text-xs font-mono"
          >
            복구
          </button>
        ) : (
          <button
            type="button"
            data-testid="fact-detail-retract"
            onClick={onRetract}
            disabled={busy}
            className="rounded border border-accent-error/40 bg-accent-error/5 text-accent-error px-3 py-1 text-xs font-mono"
          >
            사실 철회
          </button>
        )}
      </footer>
    </aside>
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

  const allEntityCounts: number[] = entities
    ? ([entities.organization, entities.person, entities.place, entities.other]
        .flatMap((arr) => arr.map((e) => e.count)))
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

// B-50: similarity-floor bounds for the slider — the backend accepts
// [0,1] but the dev guidance is 0.5–0.9 (below 0.5 fires on orthogonal
// embeddings; above 0.9 cuts most real matches).
const SCORE_THRESHOLD_MIN = 0.5;
const SCORE_THRESHOLD_MAX = 0.9;
const SCORE_THRESHOLD_DEFAULT = 0.72;

type MatchKind = 'embedding' | 'entity_link';

interface SearchControlsState {
  scoreThreshold: number;
  dateFrom: string;  // 'YYYY-MM-DD' or ''
  dateTo: string;
  matchKinds: Record<MatchKind, boolean>;
  keyword2: string;
}

const DEFAULT_CONTROLS: SearchControlsState = {
  scoreThreshold: SCORE_THRESHOLD_DEFAULT,
  dateFrom: '',
  dateTo: '',
  matchKinds: { embedding: true, entity_link: true },
  keyword2: '',
};

// B-50-fix (PO A direction): `matchKinds` is no longer a server param.
// Embedding (kNN) is the search mode — always on. The toggle in the
// panel filters the rendered result list client-side; the server
// receives the FULL envelope every time.
function controlsToRecallOptions(
  c: SearchControlsState, entity: string[],
): { entity: string[]; scoreThreshold: number; dateFrom?: string; dateTo?: string } {
  return {
    entity,
    scoreThreshold: c.scoreThreshold,
    // Backend expects ISO 8601; the date input gives 'YYYY-MM-DD',
    // which is a valid ISO 8601 calendar date. Pad to midnight UTC
    // so the inclusive range covers the whole day on both sides.
    dateFrom: c.dateFrom ? `${c.dateFrom}T00:00:00Z` : undefined,
    dateTo: c.dateTo ? `${c.dateTo}T23:59:59Z` : undefined,
  };
}

interface SearchControlsPanelProps {
  state: SearchControlsState;
  onChange: (next: SearchControlsState) => void;
}

function SearchControlsPanel({ state, onChange }: SearchControlsPanelProps) {
  return (
    <aside
      aria-label="search controls"
      data-testid="search-controls"
      className="hidden lg:block w-64 shrink-0 sticky top-4 self-start"
    >
      <h2 className="text-xxs uppercase tracking-wider text-text-muted mb-3 font-mono">
        검색 컨트롤
      </h2>

      {/* Similarity threshold */}
      <div className="mb-4">
        <label className="flex justify-between items-baseline text-xs font-medium mb-1">
          <span>유사도 임계값</span>
          <span
            data-testid="control-threshold-value"
            className="font-mono text-xxs text-text-muted"
          >
            {state.scoreThreshold.toFixed(2)}
          </span>
        </label>
        <input
          type="range"
          aria-label="similarity threshold"
          data-testid="control-threshold-slider"
          min={SCORE_THRESHOLD_MIN}
          max={SCORE_THRESHOLD_MAX}
          step={0.01}
          value={state.scoreThreshold}
          onChange={(e) =>
            onChange({ ...state, scoreThreshold: parseFloat(e.target.value) })
          }
          className="w-full"
        />
        <p className="text-xxs text-text-muted font-mono mt-0.5">
          {SCORE_THRESHOLD_MIN.toFixed(2)} – {SCORE_THRESHOLD_MAX.toFixed(2)}
        </p>
      </div>

      {/* Date range */}
      <div className="mb-4">
        <h3 className="text-xs font-medium mb-1">검증 일자</h3>
        <div className="flex flex-col gap-1">
          <input
            type="date"
            aria-label="date from"
            data-testid="control-date-from"
            value={state.dateFrom}
            onChange={(e) => onChange({ ...state, dateFrom: e.target.value })}
            className="rounded border border-border-subtle bg-bg-card px-2 py-1 text-xs"
          />
          <input
            type="date"
            aria-label="date to"
            data-testid="control-date-to"
            value={state.dateTo}
            onChange={(e) => onChange({ ...state, dateTo: e.target.value })}
            className="rounded border border-border-subtle bg-bg-card px-2 py-1 text-xs"
          />
        </div>
        {(state.dateFrom || state.dateTo) && (
          <button
            type="button"
            data-testid="control-date-clear"
            onClick={() => onChange({ ...state, dateFrom: '', dateTo: '' })}
            className="text-xxs text-text-muted hover:text-text-primary font-mono underline mt-1"
          >
            일자 초기화
          </button>
        )}
      </div>

      {/* B-50-fix: match_kind is now a display filter only. Embedding
          (kNN) is the search mode — toggle locked on; entity-link can
          be hidden from the rendered list but the seed is never
          starved (the underlying recall response is the same). */}
      <div className="mb-4">
        <h3 className="text-xs font-medium mb-1">매치 종류</h3>
        <p className="text-xxs text-text-muted font-mono mb-1">
          결과 표시 필터 (서버 재검색 없음)
        </p>
        <label
          data-testid="control-match-embedding"
          className="flex items-center gap-2 text-xs py-0.5 opacity-90"
          title="검색은 유사도 기반"
        >
          <input
            type="checkbox"
            checked={state.matchKinds.embedding}
            disabled
            aria-disabled="true"
            data-testid="control-match-embedding-checkbox"
            readOnly
          />
          <span>🔍 유사도 (검색 모드)</span>
        </label>
        <label
          data-testid="control-match-entity-link"
          className="flex items-center gap-2 text-xs py-0.5"
        >
          <input
            type="checkbox"
            checked={state.matchKinds.entity_link}
            data-testid="control-match-entity-link-checkbox"
            onChange={(e) =>
              onChange({
                ...state,
                matchKinds: { ...state.matchKinds, entity_link: e.target.checked },
              })
            }
          />
          <span>🔗 엔티티 연결</span>
        </label>
      </div>

      {/* 2nd-tier keyword — client-side filter on claim text */}
      <div className="mb-4">
        <label
          className="text-xs font-medium block mb-1"
          htmlFor="control-keyword2"
        >
          결과 내 키워드
        </label>
        <input
          id="control-keyword2"
          type="text"
          aria-label="secondary keyword"
          data-testid="control-keyword2"
          value={state.keyword2}
          onChange={(e) => onChange({ ...state, keyword2: e.target.value })}
          placeholder="claim 부분일치"
          className="w-full rounded border border-border-subtle bg-bg-card px-2 py-1 text-xs"
        />
        <p className="text-xxs text-text-muted font-mono mt-0.5">
          현재 결과만 필터 (서버 재검색 없음)
        </p>
      </div>
    </aside>
  );
}

export function RecallView({ spaceId }: Props) {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [activeEntities, setActiveEntities] = useState<string[]>([]);
  const [controls, setControls] = useState<SearchControlsState>(DEFAULT_CONTROLS);
  const [result, setResult] = useState<RecallResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // B-48b: open detail panel swaps in over the entity-brief facet panel.
  const [detail, setDetail] = useState<FactDetailResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const sortedFacts = useMemo(
    () => (result ? sortFacts(result.facts) : []),
    [result],
  );

  // B-50 / B-50-fix client-side filters.
  // - keyword2: case-insensitive substring match on `claim`.
  // - matchKinds: 🔍 유사도 is the search mode (always on); the user
  //   can hide 🔗 엔티티 연결 rows from the rendered list, but the
  //   underlying recall response is unchanged so toggling never zeros
  //   the result — the old UX trap is gone.
  const visibleFacts = useMemo(() => {
    let out = sortedFacts;
    const kw = controls.keyword2.trim().toLowerCase();
    if (kw) out = out.filter((f) => f.claim.toLowerCase().includes(kw));
    if (!controls.matchKinds.entity_link) {
      out = out.filter((f) => (f.match_kind ?? 'embedding') !== 'entity_link');
    }
    return out;
  }, [sortedFacts, controls.keyword2, controls.matchKinds.entity_link]);

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

  const runRecall = async (
    q: string,
    entities: string[],
    overrideControls?: SearchControlsState,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const opts = controlsToRecallOptions(overrideControls ?? controls, entities);
      const r = await apiRecall(spaceId, q, opts);
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

  // B-48b: open the detail panel for a fact (right rail swaps from
  // facet/brief to detail). Subsequent recall calls leave the panel
  // open — the user closes it explicitly.
  const onOpenDetail = async (factUid: string) => {
    setDetailBusy(true);
    setError(null);
    try {
      const d = await apiGetFactDetail(spaceId, factUid);
      setDetail(d);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setDetailBusy(false);
    }
  };

  const onCloseDetail = () => setDetail(null);

  const refreshDetail = async (factUid: string) => {
    try {
      const d = await apiGetFactDetail(spaceId, factUid);
      setDetail(d);
    } catch {
      // best-effort — keep the current detail rendered if refresh fails
    }
  };

  const refreshRecall = () => {
    if (submittedQuery) void runRecall(submittedQuery, activeEntities);
  };

  const onDetailRetract = async () => {
    if (!detail) return;
    setDetailBusy(true);
    try {
      await apiRetractFact(spaceId, detail.fact.fact_uid);
      await refreshDetail(detail.fact.fact_uid);
      refreshRecall();
    } finally {
      setDetailBusy(false);
    }
  };

  const onDetailRestore = async () => {
    if (!detail) return;
    setDetailBusy(true);
    try {
      await apiRestoreFact(spaceId, detail.fact.fact_uid);
      await refreshDetail(detail.fact.fact_uid);
      refreshRecall();
    } finally {
      setDetailBusy(false);
    }
  };

  const onDetailDetachSource = async (sourceUid: string) => {
    if (!detail) return;
    setDetailBusy(true);
    try {
      const r = await apiDetachSource(spaceId, detail.fact.fact_uid, sourceUid);
      await refreshDetail(detail.fact.fact_uid);
      refreshRecall();
      // If detach triggered an auto-retract, the panel updates via the
      // refresh above; we don't need to surface a toast — the banner
      // on the detail card already announces the new state.
      void r;
    } finally {
      setDetailBusy(false);
    }
  };

  // Controls dispatcher: server-affecting controls re-fire recall.
  // B-50-fix: matchKinds is no longer in that set — it's a pure
  // display filter, so changing the toggle never round-trips. keyword2
  // is also display-only.
  const onControlsChange = (next: SearchControlsState) => {
    const serverChanged =
      next.scoreThreshold !== controls.scoreThreshold ||
      next.dateFrom !== controls.dateFrom ||
      next.dateTo !== controls.dateTo;
    setControls(next);
    if (serverChanged && submittedQuery) {
      void runRecall(submittedQuery, activeEntities, next);
    }
  };

  return (
    <div className="flex gap-4 px-4 py-6 mx-auto max-w-7xl">
      <SearchControlsPanel state={controls} onChange={onControlsChange} />

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
                  관련도 {controls.scoreThreshold.toFixed(2)} 이상 매치만 표시 · 점수 내림차순 정렬
                  {result.expanded_count && result.expanded_count > 0
                    ? ` · 엔티티 연결로 추가된 ${result.expanded_count}건 포함`
                    : ''}
                  {controls.keyword2.trim() && sortedFacts.length !== visibleFacts.length
                    ? ` · 키워드 "${controls.keyword2.trim()}" 로 ${sortedFacts.length}건 중 ${visibleFacts.length}건 표시`
                    : ''}
                </p>
                {visibleFacts.length === 0 ? (
                  <p
                    data-testid="recall-keyword-empty"
                    className="text-sm text-text-muted py-4"
                  >
                    키워드 「{controls.keyword2.trim()}」 와 일치하는 결과가 없습니다.
                  </p>
                ) : (
                  visibleFacts.map((f) => (
                    <RecallFactCard key={f.fact_uid} fact={f} onOpenDetail={onOpenDetail} />
                  ))
                )}
              </>
            )}
          </section>
        )}
      </main>

      {detail ? (
        <FactDetailPanel
          detail={detail}
          onClose={onCloseDetail}
          onDetachSource={onDetailDetachSource}
          onRetract={onDetailRetract}
          onRestore={onDetailRestore}
          busy={detailBusy}
        />
      ) : (
        <FacetPanel
          facets={result?.facets}
          activeEntityUids={activeEntities}
          onToggleEntity={onToggleEntity}
        />
      )}
    </div>
  );
}
