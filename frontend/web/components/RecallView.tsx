'use client';

/**
 * RecallView — DR-089 dogfood thin slice + B-40 polish + B-60 mode toggle.
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
 *
 * B-60 — simple / power mode toggle:
 *   · Default mode is `simple`: a single column of fact cards. No left
 *     filter panel, no right facet panel. This is the "단순-기본" UX
 *     that PO asked for so the recall page is approachable for the
 *     first-time user.
 *   · Toggling to `power` reveals the existing Palantir-style 3-panel
 *     layout (left filter / center cards / right facets). Power mode
 *     is the on-demand surface; nothing changes about the search
 *     itself — both modes consume the SAME recall response, no second
 *     API call ever fires from a mode flip.
 *   · The mode is persisted in `localStorage` under
 *     `lucid.recall.mode` so the user's preference survives reloads.
 *
 * Implementation pattern:
 *   · `RecallView` owns the data (query, controls, recall result,
 *     fact-detail modal) and exposes the body via `<RecallSimpleBody>`
 *     / `<RecallPowerBody>` props — both bodies are dumb consumers.
 *   · The 3-panel power layout is preserved verbatim from B-49/B-50;
 *     no behaviour change was made to the existing panels.
 */

import { useEffect, useMemo, useState } from 'react';
import { ActionButton } from './ActionButton';
import {
  recall as apiRecall,
  ApiError,
  detachSource as apiDetachSource,
  getFactDetail as apiGetFactDetail,
  modifyFact as apiModifyFact,
  restoreFact as apiRestoreFact,
  retractFact as apiRetractFact,
} from '@/lib/api';
import { predicateLabel } from '@/lib/predicateLabels';
import type {
  EntityBrief,
  EntityBriefGroup,
  EntityFacetItem,
  FactDetailResponse,
  FactTypeFacets,
  ModifyFactRequest,
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

// feat/recall-card-original-claim — PO directive 7.
// Legacy edited facts have `claim` persisted as the pipe-joined
// "S | P | O" surface that FactCard.regenerateClaim() emits when the
// user edits in Decide UI. PO wants the recall card title to show the
// ORIGINAL sentence, not the pipe artefact. We can't recover the
// original from the stored claim (it was overwritten), but we can:
//   1. Detect the pipe-artefact shape so the card title doesn't pretend
//      this string is a natural sentence; surface a small "(재구성됨)"
//      marker so the user knows this card was edited and the original
//      sentence is no longer the title.
//   2. Fall through to the resolved S → P → O surface (which the same
//      card already shows in its metadata strip below the title) so
//      the user still sees something readable.
// Going forward, Decide should stop overwriting `claim` with the pipe
// surface — but that's a separate change; this is purely the display
// repair PO asked for in directive 7.
const PIPE_CLAIM_RE = /^[^|]+ \| [^|]+ \| [^|]+$/;

function isReconstructedClaim(claim: string | null | undefined): boolean {
  if (!claim) return false;
  return PIPE_CLAIM_RE.test(claim.trim());
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

// v0.2.0 step 3 (fact-contradiction-detection-v1): subtle amber badge
// (NOT red — detection-only, no resolution UI yet). Renders only when
// the server reports a positive contradiction_count on the fact.
function ContradictionBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="recall-badge-contradiction"
      className="rounded-full bg-amber-100 text-amber-900 border border-amber-400 px-2 py-0.5 text-xxs font-mono"
      title="이 사실은 같은 KS의 다른 사실과 모순됩니다. 자동 해소는 아직 없습니다."
    >
      ⚠ 모순 {count}건
    </span>
  );
}

function RecallFactCard({
  fact, onOpenDetail,
}: { fact: RecallFact; onOpenDetail?: (factUid: string) => void }) {
  const sourceUrls = fact.source_uids.filter((s) => s.startsWith('http'));
  const subjectDisplay = resolveLabel(fact.subject_uid, fact.subject_label);
  const objectDisplay = resolveLabel(fact.object_value, fact.object_label);
  const contradictionCount = fact.contradiction_count ?? 0;
  // feat/recall-card-original-claim — PO directive 7.
  // Prefer the original claim verbatim; if `claim` is missing or is the
  // legacy pipe artefact, fall back to a natural S → P → O surface and
  // flag the card with a "재구성됨" marker so the user understands the
  // title is not the original sentence.
  const claimText = (fact.claim ?? '').trim();
  const reconstructed = !claimText || isReconstructedClaim(claimText);
  const titleText = reconstructed
    ? `${subjectDisplay} → ${predicateLabel(fact.predicate, fact.predicate_label)} → ${objectDisplay}`
    : claimText;
  return (
    <article
      data-testid={`recall-fact-${fact.fact_uid}`}
      data-match-kind={fact.match_kind ?? 'embedding'}
      data-claim-reconstructed={reconstructed ? 'true' : 'false'}
      className="rounded-lg border border-border-subtle bg-bg-card p-4 mb-3"
    >
      <header className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <MatchKindBadge kind={fact.match_kind} />
          <ContradictionBadge count={contradictionCount} />
        </div>
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
          {titleText}
          {reconstructed && (
            <span
              data-testid={`recall-fact-${fact.fact_uid}-reconstructed`}
              className="ml-2 italic text-xxs font-mono text-text-muted"
              title="원문이 보존되지 않은 편집 사실 — 주체·술어·객체로 재구성"
            >
              (재구성됨)
            </span>
          )}
        </button>
      ) : (
        <p className="text-base mb-3" lang="ko">
          {titleText}
          {reconstructed && (
            <span
              data-testid={`recall-fact-${fact.fact_uid}-reconstructed`}
              className="ml-2 italic text-xxs font-mono text-text-muted"
              title="원문이 보존되지 않은 편집 사실 — 주체·술어·객체로 재구성"
            >
              (재구성됨)
            </span>
          )}
        </p>
      )}
      <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-2 mb-3">
        <div>
          <dt className="opacity-60">subject</dt>
          <dd data-testid={`recall-fact-${fact.fact_uid}-subject`}>{subjectDisplay}</dd>
        </div>
        <div>
          <dt className="opacity-60">predicate</dt>
          <dd>{predicateLabel(fact.predicate, fact.predicate_label)}</dd>
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

// feat/recall-fact-type-summary — fact_type taxonomy. Hoisted to the
// top of the module so the EntityBriefPanel (which renders the per-
// entity chip row introduced by feat/recall-entity-fact-type-breakdown)
// can reference the same labels / order constants as the page-level
// RecallFactTypeSummary further down. `const`/`type` are NOT hoisted
// like `function` declarations are; without this move, the per-entity
// breakdown would crash with a TDZ ReferenceError on first render.

type FactTypeKey = 'action' | 'claim' | 'measurement';

const FACT_TYPE_LABELS: Record<FactTypeKey, string> = {
  action: '행동',
  claim: '발언',
  measurement: '수치',
};

const FACT_TYPE_GLOSS: Record<FactTypeKey, string> = {
  action: 'Action',
  claim: 'Claim',
  measurement: 'Measurement',
};

const FACT_TYPE_ORDER: FactTypeKey[] = ['action', 'claim', 'measurement'];

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

// feat/recall-entity-fact-type-breakdown — PO live evidence 2026-06-24.
//
// The brief panel used to surface the entity's facts as a role split —
// "주어로서 (N)" / "목적어로서 (N)" with a "생성 0" line baked into the
// signature. PO escalation: that role split is meaningless to the user;
// what they want, mirroring the top-level summary box from
// feat/recall-fact-type-summary, is a fact_type breakdown PER entity
// (행동 / 발언 / 수치). This way each entity's contribution to the
// search is decomposed across the three knowledge layers the whole UI
// is already organised around.
//
// Data path. The backend EntityBrief / EntityFactRef shape doesn't
// carry fact_type (a deliberate constraint of this PR: no backend
// changes). The breakdown is computed frontend-side from `result.facts`
// — the recall hit set already carries `fact_type` on every RecallFact
// — filtering to facts where this entity appears as subject or object.
// This works exactly for the dogfood case PO is hitting (search-by-
// entity-name where every hit is the same entity); for the wider case
// it surfaces the fact_type split of the entity's CURRENT search hits
// rather than its lifetime facts. That tradeoff matches the rest of
// the recall surface (facets are also computed over the current hit
// set, not lifetime).
//
// The chips are clickable and dispatch to the SAME factTypeFilter that
// the top-level summary owns — so a per-entity chip click filters the
// whole result list, identical to clicking the top-level chip. That
// keeps a single source of truth (one filter, not a per-entity-local
// filter that would compete with the global one) and matches the
// muscle memory of users who already learned the top-level summary.

function computeEntityFactTypeBreakdown(
  entityUid: string,
  facts: RecallFact[],
): Record<FactTypeKey, number> {
  const counts: Record<FactTypeKey, number> = {
    action: 0,
    claim: 0,
    measurement: 0,
  };
  for (const f of facts) {
    const touchesEntity =
      f.subject_uid === entityUid || f.object_value === entityUid;
    if (!touchesEntity) continue;
    // Legacy / null fact_type — treat as 'action' to match the
    // codebase-wide fallback (RecallFactCard, FactCard, visibleFacts
    // filter all do the same).
    const t = (f.fact_type ?? 'action') as FactTypeKey;
    if (t === 'action' || t === 'claim' || t === 'measurement') {
      counts[t] += 1;
    }
  }
  return counts;
}

interface EntityBriefPanelProps {
  brief: EntityBrief;
  factTypeCounts: Record<FactTypeKey, number>;
  activeFactType: FactTypeKey | null;
  onToggleFactType: (kind: FactTypeKey) => void;
}

function EntityBriefPanel({
  brief, factTypeCounts, activeFactType, onToggleFactType,
}: EntityBriefPanelProps) {
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
          {brief.total_facts}개 검증 사실 · 술어별 그룹
        </p>
      </header>
      {/* feat/recall-entity-fact-type-breakdown — chip row replacing the
          old 주어로서 / 목적어로서 / 생성 0 facet. Visually smaller than
          the top-level summary chips (text-xxs vs text-xs, py-0.5 vs
          py-1) so the hierarchy reads as "page-level summary > entity-
          level summary"; same border / active state / disabled state
          semantics so the user instantly knows they're chips of the
          same kind. */}
      <div
        role="group"
        aria-label="entity fact type breakdown"
        data-testid="brief-fact-type-breakdown"
        data-active-filter={activeFactType ?? ''}
        className="flex flex-wrap items-center gap-2 mb-3"
      >
        {FACT_TYPE_ORDER.map((kind) => {
          const count = factTypeCounts[kind];
          const active = activeFactType === kind;
          const empty = count === 0;
          return (
            <button
              key={kind}
              type="button"
              data-testid={`brief-fact-type-chip-${kind}`}
              data-active={active ? 'true' : 'false'}
              data-empty={empty ? 'true' : 'false'}
              aria-pressed={active}
              disabled={empty}
              onClick={() => onToggleFactType(kind)}
              title={
                empty
                  ? `${FACT_TYPE_LABELS[kind]} 층위의 결과 없음`
                  : active
                  ? `${FACT_TYPE_LABELS[kind]} 필터 해제`
                  : `${FACT_TYPE_LABELS[kind]} 층위만 보기`
              }
              className={[
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xxs font-medium transition-colors',
                empty
                  ? 'border-border-subtle bg-bg-card/40 text-text-muted cursor-not-allowed opacity-60'
                  : active
                  ? 'border-accent-cool/70 bg-accent-cool/15 text-accent-cool'
                  : 'border-border-subtle bg-bg-card text-text-secondary hover:bg-bg-elevated/60 cursor-pointer',
              ].join(' ')}
            >
              <span>{FACT_TYPE_LABELS[kind]}</span>
              <span
                className="font-mono text-xxs opacity-80"
                data-testid={`brief-fact-type-count-${kind}`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
      {/* Predicate-grouped fact lists. The role split (주어로서 /
          목적어로서) is gone — we render the subject and object groups
          inline as one flat predicate list because the role distinction
          is implementation detail, not a user-facing axis. The data-
          testid prefixes (brief-group-subject- / brief-group-object-)
          remain so existing predicate-level assertions still pin to a
          stable selector. */}
      <div data-testid="brief-predicate-groups">
        {brief.as_subject.map((g) => (
          <BriefGroup key={`s-${g.predicate}`} group={g} role="subject" />
        ))}
        {brief.as_object.map((g) => (
          <BriefGroup key={`o-${g.predicate}`} group={g} role="object" />
        ))}
      </div>
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
// B-48c — fact detail MODAL (replaces the B-48b right-rail swap so the
// right rail stays on facet / brief and the wider modal canvas can lay
// the sources + meta out with proper section spacing for readability)
// ---------------------------------------------------------------------------

interface FactDetailModalProps {
  detail: FactDetailResponse;
  onClose: () => void;
  onDetachSource: (sourceUid: string) => Promise<void>;
  onRetract: () => Promise<void>;
  onRestore: () => Promise<void>;
  // feat/fact-detail-modify — PO directive 2026-06-22. The Recall
  // detail modal lets the user correct surface-level errors in place
  // (typos in the claim, an off gloss for the predicate). Identity
  // fields (subject_uid / predicate_code) are NEVER editable here.
  onModify: (payload: ModifyFactRequest) => Promise<void>;
  busy: boolean;
}

// Internal edit-form state. We mirror the FactDetailHeader fields the
// user is allowed to edit. `''` is the empty string the form coerces
// down to undefined on submit so we don't send "" to the backend when
// the user hasn't touched a field.
interface FactEditDraft {
  claim: string;
  predicate_label: string;
  object_value: string;
}

function draftFromDetail(detail: FactDetailResponse): FactEditDraft {
  return {
    claim: detail.fact.claim ?? '',
    // predicate_label is the natural-English gloss. The detail GET
    // doesn't currently surface it (the recall card uses it via
    // predicate_label on RecallFact). We seed with the canonical
    // predicate so the user can re-type. The backend update goes
    // through update_fact which writes the new value verbatim.
    predicate_label: detail.fact.predicate ?? '',
    object_value: detail.fact.object_value ?? '',
  };
}

function FactDetailModal({
  detail, onClose, onDetachSource, onRetract, onRestore, onModify, busy,
}: FactDetailModalProps) {
  const { fact, entities, sources } = detail;
  const retracted = !!fact.retracted_at;
  const trusted = sources.length >= 2;
  const subject = entities.find((e) => e.role === 'subject');
  const object = entities.find((e) => e.role === 'object');

  // feat/fact-detail-modify — edit mode flips the body from read-only
  // chrome to an inline form. State is local: a draft seeded from the
  // current detail; 저장 dispatches to onModify(), 취소 discards.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FactEditDraft>(() => draftFromDetail(detail));

  // Re-seed the draft when the upstream detail changes (after a save,
  // after a retract/restore) so a re-open of the edit panel reflects
  // the latest state, not the stale snapshot from the first render.
  useEffect(() => {
    setDraft(draftFromDetail(detail));
  }, [detail]);

  const onStartEdit = () => {
    setDraft(draftFromDetail(detail));
    setEditing(true);
  };

  const onCancelEdit = () => {
    setDraft(draftFromDetail(detail));
    setEditing(false);
  };

  const onSubmitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Build the patch payload: only fields the user actually changed,
    // and never identity fields (the form doesn't expose them). An
    // empty payload means the user clicked save without editing —
    // close edit mode without a network round-trip.
    const payload: ModifyFactRequest = {};
    if (draft.claim.trim() !== (fact.claim ?? '').trim()) {
      payload.claim = draft.claim.trim();
    }
    if (draft.predicate_label.trim() !== (fact.predicate ?? '').trim()) {
      payload.predicate_label = draft.predicate_label.trim();
    }
    if (draft.object_value.trim() !== (fact.object_value ?? '').trim()) {
      payload.object_value = draft.object_value.trim();
    }
    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }
    await onModify(payload);
    setEditing(false);
  };

  // ESC closes — global listener while the modal is mounted. In edit
  // mode, ESC cancels the edit instead of closing the modal so the
  // user doesn't lose typing on a stray keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) {
        onCancelEdit();
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // onClose / onCancelEdit are stable enough — the editing flag is
    // the only field that actually changes the handler dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="fact detail"
      data-testid="fact-detail-modal"
      data-retracted={retracted ? 'true' : 'false'}
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8 bg-black/40 backdrop-blur-sm"
      // Click on the backdrop (not the content) closes.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="fact-detail-modal-content"
        className="relative max-w-3xl w-full max-h-[90vh] overflow-y-auto rounded-xl border border-border-subtle bg-bg-elevated shadow-xl"
      >
        {/* Close button — pinned top right */}
        <button
          type="button"
          data-testid="fact-detail-close"
          onClick={onClose}
          aria-label="close fact detail"
          className="absolute top-3 right-3 text-text-muted hover:text-text-primary font-mono text-sm rounded p-1"
        >
          ✕
        </button>

        {/* Header: claim hero + retracted banner */}
        <header className="px-8 pt-8 pb-4 border-b border-border-subtle">
          {retracted && (
            <p
              data-testid="fact-detail-retracted-banner"
              className="text-xs text-accent-error mb-3 font-mono"
            >
              철회된 사실 · {new Date(fact.retracted_at!).toLocaleString()}
            </p>
          )}
          <p className="text-xxs uppercase tracking-wider text-text-muted font-mono mb-2">
            Fact 상세
          </p>
          {/* feat/recall-card-original-claim — same pipe-artefact repair
              as the recall card title; the detail hero is the same surface
              from the user's POV. */}
          {(() => {
            const claimText = (fact.claim ?? '').trim();
            const reconstructed = !claimText || isReconstructedClaim(claimText);
            const subjectName =
              subject?.name ?? fact.subject_label ?? fact.subject_uid;
            const objectName =
              object?.name ?? fact.object_label ?? fact.object_value;
            const titleText = reconstructed
              ? `${subjectName} → ${predicateLabel(fact.predicate)} → ${objectName}`
              : claimText;
            return (
              <p
                data-testid="fact-detail-claim"
                data-claim-reconstructed={reconstructed ? 'true' : 'false'}
                className="text-xl leading-relaxed font-medium"
                lang="ko"
              >
                {titleText}
                {reconstructed && (
                  <span
                    data-testid="fact-detail-claim-reconstructed"
                    className="ml-2 italic text-xxs font-mono text-text-muted align-middle"
                    title="원문이 보존되지 않은 편집 사실 — 주체·술어·객체로 재구성"
                  >
                    (재구성됨)
                  </span>
                )}
              </p>
            );
          })()}
          {fact.claim_en && (
            <p className="text-sm text-text-muted mt-2 leading-relaxed">
              {fact.claim_en}
            </p>
          )}
        </header>

        {/* S → P → O relationship — read mode renders the chip row;
            edit mode replaces it with an inline form for surface
            fields. Identity (subject) stays read-only because changing
            it requires the entity-resolver path (Decide). */}
        <section
          className="px-8 py-5 border-b border-border-subtle"
          data-testid="fact-detail-relationship"
          data-editing={editing ? 'true' : 'false'}
        >
          <h3 className="text-xxs uppercase tracking-wider text-text-muted font-mono mb-3">
            관계
          </h3>
          {editing ? (
            <form
              data-testid="fact-detail-edit-form"
              onSubmit={onSubmitEdit}
              className="space-y-3"
            >
              <div>
                <label
                  className="block text-xxs uppercase tracking-wider text-text-muted font-mono mb-1"
                  htmlFor="fact-edit-claim"
                >
                  claim
                </label>
                <textarea
                  id="fact-edit-claim"
                  data-testid="fact-detail-edit-claim"
                  value={draft.claim}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, claim: e.target.value }))
                  }
                  rows={2}
                  className="w-full rounded border border-border-subtle bg-bg-card px-3 py-2 text-sm focus:outline-none focus:border-accent-cool"
                  disabled={busy}
                  lang="ko"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    className="block text-xxs uppercase tracking-wider text-text-muted font-mono mb-1"
                    htmlFor="fact-edit-predicate"
                  >
                    predicate (gloss)
                  </label>
                  <input
                    id="fact-edit-predicate"
                    data-testid="fact-detail-edit-predicate"
                    type="text"
                    value={draft.predicate_label}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, predicate_label: e.target.value }))
                    }
                    className="w-full rounded border border-border-subtle bg-bg-card px-3 py-2 text-sm focus:outline-none focus:border-accent-cool"
                    disabled={busy}
                  />
                </div>
                <div>
                  <label
                    className="block text-xxs uppercase tracking-wider text-text-muted font-mono mb-1"
                    htmlFor="fact-edit-object"
                  >
                    object
                  </label>
                  <input
                    id="fact-edit-object"
                    data-testid="fact-detail-edit-object"
                    type="text"
                    value={draft.object_value}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, object_value: e.target.value }))
                    }
                    className="w-full rounded border border-border-subtle bg-bg-card px-3 py-2 text-sm focus:outline-none focus:border-accent-cool"
                    disabled={busy}
                    lang="ko"
                  />
                </div>
              </div>
              <p className="text-xxs text-text-muted font-mono">
                주체(subject)는 편집 불가 — 변경하려면 사실을 철회한 뒤 새로 검증하세요.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  data-testid="fact-detail-edit-cancel"
                  onClick={onCancelEdit}
                  disabled={busy}
                  className="rounded-md border border-border-subtle bg-bg-card px-3 py-1.5 text-xs"
                >
                  취소
                </button>
                <button
                  type="submit"
                  data-testid="fact-detail-edit-save"
                  disabled={busy}
                  className="rounded-md border border-accent-cool/40 bg-accent-cool/10 text-accent-cool px-3 py-1.5 text-xs font-medium"
                >
                  저장
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span
                data-testid="fact-detail-subject"
                className="rounded-md border border-border-subtle bg-bg-card px-3 py-1.5"
              >
                <span className="font-medium">
                  {subject?.name ?? fact.subject_label ?? fact.subject_uid}
                </span>
                {subject?.class && (
                  <span className="ml-2 text-xxs text-text-muted font-mono">
                    {subject.class}
                  </span>
                )}
              </span>
              <span className="text-text-muted font-mono text-xs">→</span>
              <span className="rounded-md bg-accent-cool/10 border border-accent-cool/30 text-accent-cool px-3 py-1.5 font-mono text-xs">
                {predicateLabel(fact.predicate)}
              </span>
              <span className="text-text-muted font-mono text-xs">→</span>
              <span
                data-testid="fact-detail-object"
                className="rounded-md border border-border-subtle bg-bg-card px-3 py-1.5"
              >
                <span className="font-medium">
                  {object?.name ?? fact.object_label ?? fact.object_value}
                </span>
                {object?.class && (
                  <span className="ml-2 text-xxs text-text-muted font-mono">
                    {object.class}
                  </span>
                )}
              </span>
            </div>
          )}
        </section>

        {/* Sources — the meat of the modal */}
        <section className="px-8 py-5 border-b border-border-subtle">
          <header className="flex items-center justify-between mb-3">
            <h3 className="text-xxs uppercase tracking-wider text-text-muted font-mono">
              출처 ({sources.length})
            </h3>
            {trusted && (
              <span
                data-testid="fact-detail-trust-badge"
                className="rounded-full bg-accent-cool/15 text-accent-cool border border-accent-cool/40 px-3 py-1 text-xxs font-mono"
                title="검증된 출처가 둘 이상"
              >
                ✓ 검증된 출처 {sources.length}건
              </span>
            )}
          </header>
          {sources.length === 0 ? (
            <p className="text-xs text-text-muted py-2">(출처 없음)</p>
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sources.map((s) => (
                <li
                  key={s.source_uid}
                  data-testid={`fact-detail-source-${s.source_uid}`}
                  className="rounded-lg border border-border-subtle bg-bg-card p-3"
                >
                  <div className="flex justify-between items-start gap-3 mb-2">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-accent-cool underline break-all min-w-0"
                      title={s.url}
                    >
                      {s.domain || s.url.replace(/^https?:\/\//, '').slice(0, 60)}
                    </a>
                    <button
                      type="button"
                      data-testid={`fact-detail-detach-${s.source_uid}`}
                      onClick={() => onDetachSource(s.source_uid)}
                      disabled={busy}
                      className="text-xxs text-text-muted hover:text-accent-error font-mono shrink-0 underline"
                    >
                      이 출처만 떼기
                    </button>
                  </div>
                  {s.title && (
                    <p className="text-xs text-text-secondary mb-1 leading-snug">
                      {s.title}
                    </p>
                  )}
                  <dl className="text-xxs text-text-muted font-mono space-y-0.5">
                    {s.captured_at && (
                      <div>
                        <dt className="inline opacity-60">captured: </dt>
                        <dd className="inline">
                          <time dateTime={s.captured_at}>
                            {new Date(s.captured_at).toLocaleString()}
                          </time>
                        </dd>
                      </div>
                    )}
                    {s.author && (
                      <div>
                        <dt className="inline opacity-60">author: </dt>
                        <dd className="inline">{s.author}</dd>
                      </div>
                    )}
                    {s.snapshot_available && (
                      <div>
                        <dt className="inline opacity-60">snapshot: </dt>
                        <dd className="inline">보존됨</dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Meta — validated_at / entity class / alias / edit history */}
        <section className="px-8 py-5">
          <h3 className="text-xxs uppercase tracking-wider text-text-muted font-mono mb-3">
            메타
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-xs">
            <div>
              <dt className="text-text-muted font-mono opacity-60">등록 일시</dt>
              <dd>
                <time dateTime={fact.validated_at}>
                  {new Date(fact.validated_at).toLocaleString()}
                </time>
              </dd>
            </div>
            {subject?.aliases && subject.aliases.length > 0 && (
              <div>
                <dt className="text-text-muted font-mono opacity-60">
                  subject alias
                </dt>
                <dd className="font-mono text-xxs">
                  {subject.aliases.join(', ')}
                </dd>
              </div>
            )}
            {object?.aliases && object.aliases.length > 0 && (
              <div>
                <dt className="text-text-muted font-mono opacity-60">
                  object alias
                </dt>
                <dd className="font-mono text-xxs">
                  {object.aliases.join(', ')}
                </dd>
              </div>
            )}
            {fact.edit_history && fact.edit_history.length > 0 && (
              <div>
                <dt className="text-text-muted font-mono opacity-60">
                  편집 이력
                </dt>
                <dd>{fact.edit_history.length}건</dd>
              </div>
            )}
          </dl>
        </section>

        {/* Action bar — feat/fact-detail-modify adds the 수정 button on
            the LEFT (less prominent than the retract / restore actions
            which sit at the right). The button hides in edit mode and
            when the fact is retracted (a retracted fact must be
            restored before its surface can be edited). */}
        <footer className="px-8 py-4 border-t border-border-subtle bg-bg-card/40 flex justify-between items-center gap-2">
          <div>
            {!retracted && !editing && (
              <button
                type="button"
                data-testid="fact-detail-edit"
                onClick={onStartEdit}
                disabled={busy}
                className="rounded-md border border-border-subtle bg-bg-card px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                title="claim / predicate gloss / object 텍스트만 편집 가능"
              >
                수정
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {retracted ? (
              <button
                type="button"
                data-testid="fact-detail-restore"
                onClick={onRestore}
                disabled={busy}
                className="rounded-md border border-accent-cool/40 bg-accent-cool/10 text-accent-cool px-4 py-2 text-sm font-medium"
              >
                복구
              </button>
            ) : (
              <button
                type="button"
                data-testid="fact-detail-retract"
                onClick={onRetract}
                disabled={busy || editing}
                className="rounded-md border border-accent-error/40 bg-accent-error/5 text-accent-error px-4 py-2 text-sm font-medium"
              >
                사실 철회
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
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
  // v0.2.0 step 1 (fact-claim-layer-v1) — display-only filter that
  // hides action rows so the user can drill into "who said what" only.
  claimOnly: boolean;
  // v0.2.0 step 2 (fact-measurement-layer-v1) — display-only filter
  // that hides non-measurement rows so the user can drill into the
  // verified time-series moat (numeric values pinned to a timepoint).
  measurementOnly: boolean;
}

const DEFAULT_CONTROLS: SearchControlsState = {
  scoreThreshold: SCORE_THRESHOLD_DEFAULT,
  dateFrom: '',
  dateTo: '',
  matchKinds: { embedding: true, entity_link: true },
  keyword2: '',
  claimOnly: false,
  measurementOnly: false,
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

      {/* v0.2.0 step 1 (fact-claim-layer-v1) — 화자 인용 (claim) filter.
          Display-only client-side filter: hides action rows so the user
          can drill into "who said what" without re-querying the server. */}
      <div className="mb-4">
        <h3 className="text-xs font-medium mb-1">화자 인용</h3>
        <p className="text-xxs text-text-muted font-mono mb-1">
          결과 표시 필터 (서버 재검색 없음)
        </p>
        <label
          data-testid="control-claim-only"
          className="flex items-center gap-2 text-xs py-0.5"
        >
          <input
            type="checkbox"
            checked={state.claimOnly}
            data-testid="control-claim-only-checkbox"
            onChange={(e) => onChange({ ...state, claimOnly: e.target.checked })}
          />
          <span>💬 화자 인용만 (claim)</span>
        </label>
      </div>

      {/* v0.2.0 step 2 (fact-measurement-layer-v1) — 수치 (measurement)
          filter. Same client-side display-only contract as claimOnly.
          Toggling does NOT re-query the server; it filters the rendered
          list down to fact_type='measurement' rows so the user can browse
          the verified time-series moat (metric / value / unit / as_of)
          without the action / claim noise. */}
      <div className="mb-4">
        <h3 className="text-xs font-medium mb-1">수치</h3>
        <p className="text-xxs text-text-muted font-mono mb-1">
          결과 표시 필터 (서버 재검색 없음)
        </p>
        <label
          data-testid="control-measurement-only"
          className="flex items-center gap-2 text-xs py-0.5"
        >
          <input
            type="checkbox"
            checked={state.measurementOnly}
            data-testid="control-measurement-only-checkbox"
            onChange={(e) => onChange({ ...state, measurementOnly: e.target.checked })}
          />
          <span>📊 수치만 (measurement)</span>
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

// ---------------------------------------------------------------------------
// feat/recall-fact-type-summary — fact_type 층위 별 요약 박스.
//
// PO live evidence (2026-06-24):
//   "recall 했을 때 claim 층위인지 measure 층위인지 action 층위인지
//    구분이 하나도 안 된 상태로 검색되어진다. '삼성전기' 검색하면 주어
//    로서(action 층위), claim 몇 건, measurement 몇 건 이런게 요약 박스에
//    나와야 하고 나머지는 페이지네이션 리스트업 하는게 맞다."
//
// The summary banner lives ABOVE the result list in BOTH simple and
// power modes. Each chip:
//   · displays the Korean label + the count from facets.fact_types,
//   · toggles a fact_type filter on click (visually highlights when
//     active; click again to clear),
//   · is disabled when the count is 0 so a zero bucket can't become
//     an empty filter trap.
//
// The total fact count from the recall envelope is rendered as a
// passive "전체 N건" pseudo-chip on the left so the user sees the
// overall result size at a glance.
//
// Backwards compat: the existing claimOnly / measurementOnly checkbox
// chips in the power rail keep working — toggling either reads the
// same `factTypeFilter` state, so the new summary box is the single
// source of truth. The checkboxes act as a redundant power-user knob.
//
// Note — FactTypeKey / FACT_TYPE_LABELS / FACT_TYPE_GLOSS / FACT_TYPE_ORDER
// were hoisted to the top of the module by
// feat/recall-entity-fact-type-breakdown so EntityBriefPanel can share
// the same taxonomy; the summary box below reuses those constants
// verbatim.
// ---------------------------------------------------------------------------

interface RecallFactTypeSummaryProps {
  total: number;
  factTypes: FactTypeFacets | undefined;
  activeFilter: FactTypeKey | null;
  onToggle: (kind: FactTypeKey) => void;
  query: string | null;
}

function RecallFactTypeSummary({
  total, factTypes, activeFilter, onToggle, query,
}: RecallFactTypeSummaryProps) {
  // Build the chip rows. Counts default to 0 when the backend omitted
  // the bucket (legacy responses) or when facets is missing entirely.
  const counts: Record<FactTypeKey, number> = {
    action: factTypes?.action ?? 0,
    claim: factTypes?.claim ?? 0,
    measurement: factTypes?.measurement ?? 0,
  };
  return (
    <section
      aria-label="recall fact type summary"
      data-testid="recall-fact-type-summary"
      data-active-filter={activeFilter ?? ''}
      className="rounded-lg border border-border-subtle bg-bg-card/60 px-4 py-3 mb-4"
    >
      <header className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
        <h2 className="text-xs font-medium text-text-secondary">
          검색 결과 요약{query ? ` · ${query}` : ''}
        </h2>
        <span
          data-testid="recall-summary-total"
          className="text-xxs font-mono text-text-muted"
        >
          전체 {total}건
        </span>
      </header>
      <div
        role="group"
        aria-label="fact type filter"
        className="flex flex-wrap items-center gap-2"
      >
        {FACT_TYPE_ORDER.map((kind) => {
          const count = counts[kind];
          const active = activeFilter === kind;
          const empty = count === 0;
          return (
            <button
              key={kind}
              type="button"
              data-testid={`recall-summary-chip-${kind}`}
              data-active={active ? 'true' : 'false'}
              data-empty={empty ? 'true' : 'false'}
              aria-pressed={active}
              disabled={empty}
              onClick={() => onToggle(kind)}
              title={
                empty
                  ? `${FACT_TYPE_LABELS[kind]} 층위의 결과 없음`
                  : active
                  ? `${FACT_TYPE_LABELS[kind]} 필터 해제`
                  : `${FACT_TYPE_LABELS[kind]} 층위만 보기`
              }
              className={[
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                empty
                  ? 'border-border-subtle bg-bg-card/40 text-text-muted cursor-not-allowed opacity-60'
                  : active
                  ? 'border-accent-cool/70 bg-accent-cool/15 text-accent-cool'
                  : 'border-border-subtle bg-bg-card text-text-secondary hover:bg-bg-elevated/60 cursor-pointer',
              ].join(' ')}
            >
              <span>{FACT_TYPE_LABELS[kind]}</span>
              <span
                className="font-mono text-xxs opacity-80"
                data-testid={`recall-summary-count-${kind}`}
              >
                {count}
              </span>
              <span className="font-mono text-xxs opacity-50">
                {FACT_TYPE_GLOSS[kind]}
              </span>
            </button>
          );
        })}
        {activeFilter && (
          <button
            type="button"
            data-testid="recall-summary-clear"
            onClick={() => onToggle(activeFilter)}
            className="ml-1 text-xxs font-mono text-text-muted hover:text-text-primary underline"
            title="층위 필터 해제"
          >
            층위 해제
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// feat/recall-fact-type-summary — pagination footer.
//
// PO's "나머지는 페이지네이션 리스트업". We use a "더 보기" (load-more)
// button rather than numbered pages because:
//   1. The full recall envelope is already in memory — pagination is
//      pure client-side slicing, no server round-trip per page.
//   2. Load-more matches the way the user scans (top-down, score-
//      ordered); jumping to "page 5" of a relevance list is an
//      anti-pattern.
//   3. It composes cleanly with the layer chip filter — flipping a
//      filter chip resets the page window without surprise.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

interface RecallPaginationFooterProps {
  shown: number;
  total: number;
  onLoadMore: () => void;
}

function RecallPaginationFooter({
  shown, total, onLoadMore,
}: RecallPaginationFooterProps) {
  if (total === 0) return null;
  const hasMore = shown < total;
  return (
    <footer
      data-testid="recall-pagination"
      className="mt-2 mb-6 flex items-center justify-between text-xxs font-mono text-text-muted"
    >
      <span data-testid="recall-pagination-progress">
        {shown}/{total}건 표시
      </span>
      {hasMore && (
        <button
          type="button"
          data-testid="recall-pagination-more"
          onClick={onLoadMore}
          className="rounded-md border border-border-subtle bg-bg-card px-3 py-1 text-xs text-text-secondary hover:bg-bg-elevated/60"
        >
          더 보기 ({Math.min(PAGE_SIZE, total - shown)}건 추가)
        </button>
      )}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// B-60 — Simple body. The "단순-기본" mode strips the left filter rail
// and right facet rail; the page becomes a single column of fact cards
// stacked vertically. Everything else (predicate Korean label, modal,
// score badge, source chips) is identical to power mode — only the
// chrome around the list changes.
//
// feat/recall-fact-type-summary — the fact_type summary box renders
// directly under the signature line in both modes; the page slice is
// derived in the shell and passed in via `pagedFacts`.
// ---------------------------------------------------------------------------

interface RecallSimpleBodyProps {
  result: RecallResponse | null;
  visibleFacts: RecallFact[];
  pagedFacts: RecallFact[];
  error: string | null;
  factTypeFilter: FactTypeKey | null;
  onToggleFactType: (kind: FactTypeKey) => void;
  onLoadMore: () => void;
  query: string | null;
  onOpenDetail: (factUid: string) => void;
}

function RecallSimpleBody({
  result, visibleFacts, pagedFacts, error,
  factTypeFilter, onToggleFactType, onLoadMore,
  query, onOpenDetail,
}: RecallSimpleBodyProps) {
  return (
    <>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-accent-error/40 bg-accent-error/5 p-3 text-sm text-accent-error"
        >
          {error}
        </p>
      )}

      {result && (
        <section aria-label="recall result" data-testid="recall-simple-body">
          <p
            data-testid="recall-signature"
            className="text-sm text-text-primary mb-2 font-medium"
          >
            {result.signature}
          </p>
          <RecallFactTypeSummary
            total={result.total ?? result.facts.length}
            factTypes={result.facets?.fact_types}
            activeFilter={factTypeFilter}
            onToggle={onToggleFactType}
            query={query}
          />
          {pagedFacts.length > 0 && (
            pagedFacts.map((f) => (
              <RecallFactCard key={f.fact_uid} fact={f} onOpenDetail={onOpenDetail} />
            ))
          )}
          <RecallPaginationFooter
            shown={pagedFacts.length}
            total={visibleFacts.length}
            onLoadMore={onLoadMore}
          />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// B-60 — Power body. The existing Palantir-style 3-panel layout is
// preserved verbatim from B-49/B-50: left filter rail (search
// controls + active chips), centre column (entity brief + cards), right
// facet rail. Behaviour is unchanged from pre-B-60.
// ---------------------------------------------------------------------------

interface RecallPowerBodyProps {
  result: RecallResponse | null;
  sortedFacts: RecallFact[];
  visibleFacts: RecallFact[];
  pagedFacts: RecallFact[];
  error: string | null;
  controls: SearchControlsState;
  onControlsChange: (next: SearchControlsState) => void;
  activeFilterDetails: { uid: string; name: string; bucket: string }[];
  activeEntities: string[];
  onToggleEntity: (uid: string) => void;
  onRemoveChip: (uid: string) => void;
  onClearAll: () => void;
  factTypeFilter: FactTypeKey | null;
  onToggleFactType: (kind: FactTypeKey) => void;
  onLoadMore: () => void;
  query: string | null;
  onOpenDetail: (factUid: string) => void;
}

function RecallPowerBody({
  result, sortedFacts, visibleFacts, pagedFacts, error,
  controls, onControlsChange,
  activeFilterDetails, activeEntities,
  onToggleEntity, onRemoveChip, onClearAll,
  factTypeFilter, onToggleFactType, onLoadMore,
  query, onOpenDetail,
}: RecallPowerBodyProps) {
  return (
    <div className="flex gap-4" data-testid="recall-power-body">
      <SearchControlsPanel state={controls} onChange={onControlsChange} />

      <main className="flex-1 min-w-0">
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
            <RecallFactTypeSummary
              total={result.total ?? result.facts.length}
              factTypes={result.facets?.fact_types}
              activeFilter={factTypeFilter}
              onToggle={onToggleFactType}
              query={query}
            />
            {result.entity_brief && (
              <EntityBriefPanel
                brief={result.entity_brief}
                factTypeCounts={computeEntityFactTypeBreakdown(
                  result.entity_brief.entity_uid,
                  result.facts,
                )}
                activeFactType={factTypeFilter}
                onToggleFactType={onToggleFactType}
              />
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
                    {controls.keyword2.trim()
                      ? `키워드 「${controls.keyword2.trim()}」 와 일치하는 결과가 없습니다.`
                      : factTypeFilter
                      ? `${FACT_TYPE_LABELS[factTypeFilter]} 층위의 결과가 없습니다.`
                      : '표시할 결과가 없습니다.'}
                  </p>
                ) : (
                  <>
                    {pagedFacts.map((f) => (
                      <RecallFactCard key={f.fact_uid} fact={f} onOpenDetail={onOpenDetail} />
                    ))}
                    <RecallPaginationFooter
                      shown={pagedFacts.length}
                      total={visibleFacts.length}
                      onLoadMore={onLoadMore}
                    />
                  </>
                )}
              </>
            )}
          </section>
        )}
      </main>

      {/* B-48c: right rail stays on facet/brief unconditionally;
          fact detail is rendered as a modal overlay outside the
          flex row so it can use the full viewport width. */}
      <FacetPanel
        facets={result?.facets}
        activeEntityUids={activeEntities}
        onToggleEntity={onToggleEntity}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// B-60 — RecallView shell. Owns all data (query, recall response,
// modal, controls) and dispatches the body to RecallSimpleBody or
// RecallPowerBody based on `mode`. The mode toggle button lives in the
// page header next to the search bar.
// ---------------------------------------------------------------------------

type RecallMode = 'simple' | 'power';

const RECALL_MODE_STORAGE_KEY = 'lucid.recall.mode';

function loadStoredMode(): RecallMode {
  // SSR-safe: localStorage is only read on the client.
  if (typeof window === 'undefined') return 'simple';
  try {
    const v = window.localStorage.getItem(RECALL_MODE_STORAGE_KEY);
    return v === 'power' ? 'power' : 'simple';
  } catch {
    return 'simple';
  }
}

function persistMode(mode: RecallMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECALL_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
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
  // B-60: simple is the default; power is opt-in. We start in simple
  // on SSR (deterministic markup) and hydrate from localStorage in an
  // effect so a returning user lands back in the rail they prefer.
  const [mode, setMode] = useState<RecallMode>('simple');
  // feat/recall-fact-type-summary — fact_type chip filter. `null` =
  // show all layers. Toggling a chip flips this to its kind; clicking
  // the same chip again clears back to null. A new query also resets.
  const [factTypeFilter, setFactTypeFilter] = useState<FactTypeKey | null>(null);
  // feat/recall-fact-type-summary — pagination window. The body
  // renders the first `displayLimit` facts of `visibleFacts`; "더 보기"
  // bumps it by PAGE_SIZE. Resets on each new query + on filter flip.
  const [displayLimit, setDisplayLimit] = useState<number>(PAGE_SIZE);

  useEffect(() => {
    const stored = loadStoredMode();
    if (stored !== 'simple') setMode(stored);
  }, []);

  const onToggleMode = () => {
    setMode((prev) => {
      const next = prev === 'simple' ? 'power' : 'simple';
      persistMode(next);
      return next;
    });
  };

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
  // B-60: visibleFacts is shared by both modes. Simple mode ignores
  // the keyword2 / matchKinds controls (they live in the power rail);
  // because the controls default to "all on / empty keyword", the
  // simple mode renders the full sorted list.
  const visibleFacts = useMemo(() => {
    let out = sortedFacts;
    const kw = controls.keyword2.trim().toLowerCase();
    if (kw) out = out.filter((f) => f.claim.toLowerCase().includes(kw));
    if (!controls.matchKinds.entity_link) {
      out = out.filter((f) => (f.match_kind ?? 'embedding') !== 'entity_link');
    }
    // v0.2.0 step 1 (fact-claim-layer-v1) — hide action rows when
    // the 화자 인용만 chip is on. Legacy facts (fact_type undefined)
    // are treated as action — the FactCard renders them identically.
    if (controls.claimOnly) {
      out = out.filter((f) => f.fact_type === 'claim');
    }
    // v0.2.0 step 2 (fact-measurement-layer-v1) — hide non-measurement
    // rows when the 수치만 chip is on. claimOnly + measurementOnly
    // together is intentionally permissive (intersection empty unless
    // a fact carries both tags — vanishingly rare); the UX is "either
    // chip filters to its own bucket".
    if (controls.measurementOnly) {
      out = out.filter((f) => f.fact_type === 'measurement');
    }
    // feat/recall-fact-type-summary — the summary-box chip filter.
    // 'action' matches both explicit action rows and legacy facts
    // where fact_type is unset / null (legacy is treated as action
    // throughout the codebase — see RecallFactCard / FactCard).
    if (factTypeFilter) {
      out = out.filter((f) => {
        const t = f.fact_type ?? 'action';
        return t === factTypeFilter;
      });
    }
    return out;
  }, [
    sortedFacts,
    controls.keyword2,
    controls.matchKinds.entity_link,
    controls.claimOnly,
    controls.measurementOnly,
    factTypeFilter,
  ]);

  // feat/recall-fact-type-summary — paginated slice of visibleFacts.
  // Client-side only; the backend already returned the full envelope
  // and pagination is a render-window concern, not a fetch concern.
  const pagedFacts = useMemo(
    () => visibleFacts.slice(0, displayLimit),
    [visibleFacts, displayLimit],
  );

  // Reset the page window whenever the underlying visible list
  // shrinks/grows because of a filter flip — the user expects to land
  // back at the top of the new bucket, not a half-scrolled offset.
  useEffect(() => {
    setDisplayLimit(PAGE_SIZE);
  }, [factTypeFilter, controls.keyword2, controls.claimOnly, controls.measurementOnly, controls.matchKinds.entity_link]);

  const onToggleFactType = (kind: FactTypeKey) => {
    setFactTypeFilter((prev) => (prev === kind ? null : kind));
  };

  const onLoadMore = () => {
    setDisplayLimit((prev) => prev + PAGE_SIZE);
  };

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
    // feat/recall-fact-type-summary — also reset the layer chip and
    // pagination window so a new query lands on the unfiltered first
    // page, matching the user's mental model of "fresh search".
    setFactTypeFilter(null);
    setDisplayLimit(PAGE_SIZE);
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

  // feat/fact-detail-modify — PATCH surface fields. The backend
  // returns the refreshed detail so we swap state from the response
  // directly (no extra GET). After save, also refetch the recall
  // list so the card title (which pulls from `claim`) is current.
  const onDetailModify = async (payload: ModifyFactRequest) => {
    if (!detail) return;
    setDetailBusy(true);
    setError(null);
    try {
      const updated = await apiModifyFact(
        spaceId, detail.fact.fact_uid, payload,
      );
      setDetail(updated);
      refreshRecall();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(msg);
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
    <div className="px-4 py-6 mx-auto max-w-7xl" data-recall-mode={mode}>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-light">Recall</h1>
          <p className="text-sm text-text-secondary">
            그래프 안의 사실만 답합니다. 그래프 밖은 답하지 않습니다.
          </p>
        </div>
        <button
          type="button"
          data-testid="recall-mode-toggle"
          aria-label="toggle recall layout mode"
          aria-pressed={mode === 'power'}
          onClick={onToggleMode}
          className="shrink-0 mt-1 rounded-md border border-border-subtle bg-bg-card px-3 py-1.5 text-xs font-mono text-text-secondary hover:bg-bg-elevated/60"
          title="단순 보기 ↔ 고급/그래프 보기"
        >
          {mode === 'simple' ? '고급/그래프 보기 →' : '← 단순 보기'}
        </button>
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

      {mode === 'simple' ? (
        <RecallSimpleBody
          result={result}
          visibleFacts={visibleFacts}
          pagedFacts={pagedFacts}
          error={error}
          factTypeFilter={factTypeFilter}
          onToggleFactType={onToggleFactType}
          onLoadMore={onLoadMore}
          query={submittedQuery}
          onOpenDetail={onOpenDetail}
        />
      ) : (
        <RecallPowerBody
          result={result}
          sortedFacts={sortedFacts}
          visibleFacts={visibleFacts}
          pagedFacts={pagedFacts}
          error={error}
          controls={controls}
          onControlsChange={onControlsChange}
          activeFilterDetails={activeFilterDetails}
          activeEntities={activeEntities}
          onToggleEntity={onToggleEntity}
          onRemoveChip={onRemoveChip}
          onClearAll={onClearAll}
          factTypeFilter={factTypeFilter}
          onToggleFactType={onToggleFactType}
          onLoadMore={onLoadMore}
          query={submittedQuery}
          onOpenDetail={onOpenDetail}
        />
      )}

      {detail && (
        <FactDetailModal
          detail={detail}
          onClose={onCloseDetail}
          onDetachSource={onDetailDetachSource}
          onRetract={onDetailRetract}
          onRestore={onDetailRestore}
          onModify={onDetailModify}
          busy={detailBusy}
        />
      )}
    </div>
  );
}
