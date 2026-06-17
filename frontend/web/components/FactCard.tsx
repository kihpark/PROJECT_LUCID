'use client';

import { useState } from 'react';
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
  // B-31: every fact lands with a default `action` ('accept'), so this
  // is required (no longer optional). The parent never carries
  // 'undecided' state any more — the page enters fully decided in
  // the user's favour, and the user only touches exceptions.
  action: FactAction;
  editedClaim?: string;
  onChange: (next: { action: FactAction; editedClaim?: string }) => void;
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

function buildLabelMap(
  objects: ObjectSummary[] | undefined,
): Map<string, ObjectSummary> {
  const m = new Map<string, ObjectSummary>();
  if (!objects) return m;
  for (const o of objects) m.set(o.uid, o);
  return m;
}

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
    // Looks like an object ref the structure stage failed to emit.
    // Surface it explicitly so the dogfood UX shows the problem instead
    // of a raw internal id pretending to be a name.
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
  reviewMode = false,
  spaceId,
}: Props) {
  const factUid = fact.fact_uid || fact.uid || '?';
  const [draft, setDraft] = useState(editedClaim ?? '');
  const isEditing = action === 'edit';
  const isDiscarded = action === 'discard';
  // B-31 checkbox: a fact is "kept" when it will land in the graph on
  // Submit. Edit-state counts as kept (the user is refining the claim,
  // not rejecting it).
  const isChecked = action !== 'discard';

  const labelMap = buildLabelMap(objects);
  const subjectLabel = resolveEntity(fact.subject_uid, labelMap, lang);
  const objectLabel = resolveEntity(fact.object_value, labelMap, lang);

  const onToggleChecked = () => {
    if (isChecked) {
      onChange({ action: 'discard' });
    } else {
      // Restore to accept; preserve any in-flight editedClaim so a
      // user who toggles back gets their text back.
      onChange(
        editedClaim
          ? { action: 'edit', editedClaim }
          : { action: 'accept' },
      );
    }
  };

  return (
    <article
      data-testid={`fact-card-${factUid}`}
      data-state={action}
      className={[
        'rounded-lg border p-4 mb-3 transition-colors',
        isDiscarded
          ? 'border-border-subtle bg-bg-elevated/30 opacity-50'
          : 'border-border-subtle bg-bg-card hover:bg-bg-card-hover',
      ].join(' ')}
    >
      <header className="flex items-start gap-3 mb-2">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={onToggleChecked}
          aria-label="Keep this fact"
          data-testid={`fact-checkbox-${factUid}`}
          className="mt-1 h-4 w-4 cursor-pointer accent-accent-cool"
        />
        <div className="flex-1 flex items-baseline justify-between">
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
        </div>
      </header>
      <p className="text-base mb-3 pl-7" lang={lang === 'kr' ? 'ko' : 'en'}>
        {displayClaim(fact, lang)}
      </p>
      {(fact.subject_uid || fact.predicate || fact.object_value) && (
        <dl className="text-xxs text-text-muted font-mono grid grid-cols-3 gap-2 mb-3 pl-7">
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
        <div className="mb-3 pl-7">
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
      <div className="flex gap-2 flex-wrap pl-7">
        <ActionButton
          variant="secondary"
          active={isEditing}
          onClick={() => onChange({ action: 'edit', editedClaim: draft || fact.claim })}
          disabled={isDiscarded}
        >
          Edit
        </ActionButton>
        <ActionButton
          variant={isDiscarded ? 'danger' : 'ghost'}
          active={isDiscarded}
          onClick={() => onChange({ action: 'discard' })}
        >
          Discard
        </ActionButton>
      </div>
      {reviewMode && spaceId && (
        <GraphNoteEditor spaceId={spaceId} factUid={factUid} />
      )}
    </article>
  );
}
