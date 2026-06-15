'use client';

import { useState } from 'react';
import { ActionButton } from './ActionButton';
import { GraphNoteEditor } from './GraphNoteEditor';
import type { FactAction, FactSummary } from '@/lib/types';
import type { Lang } from './LangToggle';

interface Props {
  fact: FactSummary;
  lang: Lang;
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

export function FactCard({
  fact,
  lang,
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
            <dd>{fact.subject_uid || '—'}</dd>
          </div>
          <div>
            <dt className="opacity-60">predicate</dt>
            <dd>{fact.predicate || '—'}</dd>
          </div>
          <div>
            <dt className="opacity-60">object</dt>
            <dd>{fact.object_value || '—'}</dd>
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
