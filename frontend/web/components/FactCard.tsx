'use client';

import { useMemo, useState } from 'react';
import { ActionButton } from './ActionButton';
import { GraphNoteEditor } from './GraphNoteEditor';
import type { FactAction, FactSummary, ObjectSummary } from '@/lib/types';
import type { Lang } from './LangToggle';

interface Props {
  fact: FactSummary;
  lang: Lang;
  // B-27: when present, FactCard resolves subject_uid / object_value
  // references like "obj-1" against this list and displays the
  // object's human-readable name (or name_en in EN mode). If a value
  // matches the obj-N shape but has no entry, the card shows a
  // "(미해석)" / "(unresolved)" marker rather than the raw ref so the
  // PO can spot serialization gaps in dogfood. Plain literal values
  // (numbers, dates, "흑자" etc.) pass through unchanged.
  objects?: ObjectSummary[];
  action?: FactAction;
  editedClaim?: string;
  onChange: (next: { action: FactAction; editedClaim?: string }) => void;
  // B-28: returns this fact to the undecided state. The parent removes
  // it from the shared decisions map. Visible only when an action is
  // currently set; the button stays disabled otherwise so the affordance
  // is discoverable without polluting the no-decision row.
  onUndo?: () => void;
  reviewMode?: boolean;
  spaceId?: string;
}

function displayClaim(fact: FactSummary, lang: Lang): string {
  if (lang === 'en') {
    return fact.claim_en || fact.claim;
  }
  return fact.claim;
}

const OBJECT_REF_PATTERN = /^obj-\d+$/i;

function resolveEntity(
  value: string | undefined,
  labelMap: Map<string, ObjectSummary>,
  lang: Lang,
): string {
  if (!value) return '—';
  const obj = labelMap.get(value);
  if (obj) {
    if (lang === 'en' && obj.name_en) return obj.name_en;
    return obj.name;
  }
  if (OBJECT_REF_PATTERN.test(value)) {
    // Looks like an object ref the structure stage failed to emit. Surface
    // it explicitly so the dogfood UX shows the problem instead of a raw
    // internal id pretending to be a name.
    return lang === 'en' ? `${value} (unresolved)` : `${value} (미해석)`;
  }
  return value;
}

export function FactCard({
  fact,
  lang,
  objects,
  action,
  editedClaim,
  onChange,
  onUndo,
  reviewMode = false,
  spaceId,
}: Props) {
  const factUid = fact.fact_uid || fact.uid || '?';
  const [draft, setDraft] = useState(editedClaim ?? '');
  const isEditing = action === 'edit';
  const isDiscarded = action === 'discard';
  const hasAction = action !== undefined;

  const labelMap = useMemo(() => {
    const m = new Map<string, ObjectSummary>();
    if (!objects) return m;
    for (const o of objects) m.set(o.uid, o);
    return m;
  }, [objects]);

  const subjectLabel = resolveEntity(fact.subject_uid, labelMap, lang);
  const objectLabel = resolveEntity(fact.object_value, labelMap, lang);

  return (
    <article
      data-testid={`fact-card-${factUid}`}
      data-state={action ?? 'undecided'}
      className={[
        'rounded-lg border p-4 mb-3 transition-colors',
        isDiscarded
          ? 'border-border-subtle bg-bg-elevated/30 opacity-50'
          : 'border-border-subtle bg-bg-card hover:bg-bg-card-hover',
      ].join(' ')}
    >
      <header className="flex items-start justify-between mb-2">
        <code className="text-xxs text-text-muted font-mono">{factUid}</code>
        {fact.negation_flag && (
          <span
            className="inline-flex items-center gap-1 text-xxs text-accent-error font-mono"
            aria-label="negation warning"
            role="status"
          >
            ⚠ negation_flag
            {fact.negation_scope ? ` (${fact.negation_scope})` : ''}
          </span>
        )}
      </header>
      <p className="text-base mb-3" lang={lang === 'kr' ? 'ko' : 'en'}>
        {displayClaim(fact, lang)}
      </p>
      {(fact.subject_uid || fact.predicate || fact.object_value) && (
        <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-2 mb-3">
          <div>
            <dt className="opacity-60">subject</dt>
            <dd data-testid="fact-subject">{subjectLabel}</dd>
          </div>
          <div>
            <dt className="opacity-60">predicate</dt>
            <dd data-testid="fact-predicate">{fact.predicate || '—'}</dd>
          </div>
          <div>
            <dt className="opacity-60">object</dt>
            <dd data-testid="fact-object">{objectLabel}</dd>
          </div>
        </dl>
      )}
      {isEditing && (
        <div className="mb-3">
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onChange({ action: 'edit', editedClaim: e.target.value });
            }}
            placeholder="Edited claim..."
            className={
              'w-full rounded-md border border-border-subtle bg-bg-elevated ' +
              'p-2 text-sm text-text-primary focus:outline-none ' +
              'focus:border-accent-cool'
            }
            rows={3}
          />
          <p className="text-xxs text-text-muted mt-1">
            Original claim preserved as alias on the persisted FactNode (DR-036).
          </p>
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        <ActionButton
          variant={action === 'accept' ? 'primary' : 'secondary'}
          active={action === 'accept'}
          onClick={() => onChange({ action: 'accept' })}
        >
          Accept
        </ActionButton>
        <ActionButton
          variant="secondary"
          active={action === 'edit'}
          onClick={() => onChange({ action: 'edit', editedClaim: draft || fact.claim })}
        >
          Edit
        </ActionButton>
        <ActionButton
          variant={action === 'discard' ? 'danger' : 'ghost'}
          active={action === 'discard'}
          onClick={() => onChange({ action: 'discard' })}
        >
          Discard
        </ActionButton>
        {onUndo && (
          <ActionButton
            variant="ghost"
            disabled={!hasAction}
            onClick={onUndo}
            aria-label="Undo this decision"
          >
            Undo
          </ActionButton>
        )}
      </div>
      {reviewMode && spaceId && (
        <GraphNoteEditor spaceId={spaceId} factUid={factUid} />
      )}
    </article>
  );
}
