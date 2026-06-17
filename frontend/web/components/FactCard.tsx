'use client';

import { useMemo } from 'react';
import { ActionButton } from './ActionButton';
import { GraphNoteEditor } from './GraphNoteEditor';
import type { FactAction, FactSummary, ObjectSummary } from '@/lib/types';
import type { Lang } from './LangToggle';

interface EditPayload {
  action: FactAction;
  editedClaim?: string;
  editedSubjectUid?: string;
  editedPredicate?: string;
  editedObjectValue?: string;
}

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
  // is required (no longer optional).
  action: FactAction;
  // B-34: structured edit state. When `action === 'edit'`, the parent
  // tracks per-fact subject/predicate/object overrides here. Each field
  // falls back to the fact's original triple if not set.
  editedClaim?: string;
  editedSubjectUid?: string;
  editedPredicate?: string;
  editedObjectValue?: string;
  onChange: (next: EditPayload) => void;
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

function buildNameToUidMap(
  objects: ObjectSummary[] | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!objects) return m;
  for (const o of objects) {
    if (o.name) m.set(o.name, o.uid);
    if (o.name_en && !m.has(o.name_en)) m.set(o.name_en, o.uid);
  }
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
    return lang === 'en' ? `${value} (unresolved)` : `${value} (미해석)`;
  }
  return value;
}

/**
 * Build the regenerated claim preview from the (possibly edited) triple.
 * Triple notation rather than natural language — the claim is the
 * persisted FactNode.claim, and `[S | P | O]` is honest about what
 * we have (a triple) without pretending to be a sentence.
 */
function regenerateClaim(
  subjectLabel: string,
  predicate: string,
  objectLabel: string,
): string {
  const s = subjectLabel || '?';
  const p = predicate || '?';
  const o = objectLabel || '?';
  return `${s} | ${p} | ${o}`;
}

export function FactCard({
  fact,
  lang,
  objects,
  action,
  editedClaim,
  editedSubjectUid,
  editedPredicate,
  editedObjectValue,
  onChange,
  reviewMode = false,
  spaceId,
}: Props) {
  const factUid = fact.fact_uid || fact.uid || '?';
  const isEditing = action === 'edit';
  const isDiscarded = action === 'discard';
  const isChecked = action !== 'discard';

  const labelMap = useMemo(() => buildLabelMap(objects), [objects]);
  const nameToUid = useMemo(() => buildNameToUidMap(objects), [objects]);

  const currentSubject = editedSubjectUid ?? fact.subject_uid ?? '';
  const currentPredicate = editedPredicate ?? fact.predicate ?? '';
  const currentObject = editedObjectValue ?? fact.object_value ?? '';

  const subjectLabel = resolveEntity(currentSubject, labelMap, lang);
  const objectLabel = resolveEntity(currentObject, labelMap, lang);

  // Build the regenerated claim from the current (possibly edited)
  // triple. While in edit mode this updates as the user types; when
  // not in edit mode the fact's original claim is shown via
  // `displayClaim` instead.
  const previewClaim = useMemo(
    () => regenerateClaim(subjectLabel, currentPredicate, objectLabel),
    [subjectLabel, currentPredicate, objectLabel],
  );

  const emitEdit = (
    next: {
      subject?: string;
      predicate?: string;
      object?: string;
    },
  ) => {
    const nextSubject = next.subject ?? currentSubject;
    const nextPredicate = next.predicate ?? currentPredicate;
    const nextObject = next.object ?? currentObject;
    // Auto-resolve object: if the user typed a name that matches a known
    // entity, store the uid; otherwise treat as literal.
    const resolvedObject = nameToUid.get(nextObject) ?? nextObject;
    const nextSubjectLabel = resolveEntity(nextSubject, labelMap, lang);
    const nextObjectLabel = resolveEntity(resolvedObject, labelMap, lang);
    const nextClaim = regenerateClaim(
      nextSubjectLabel,
      nextPredicate,
      nextObjectLabel,
    );
    onChange({
      action: 'edit',
      editedClaim: nextClaim,
      editedSubjectUid: nextSubject,
      editedPredicate: nextPredicate,
      editedObjectValue: resolvedObject,
    });
  };

  const onToggleChecked = () => {
    if (isChecked) {
      onChange({ action: 'discard' });
    } else {
      onChange(
        editedClaim
          ? {
              action: 'edit',
              editedClaim,
              editedSubjectUid,
              editedPredicate,
              editedObjectValue,
            }
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
        {isEditing ? previewClaim : displayClaim(fact, lang)}
      </p>
      {!isEditing
        && (fact.subject_uid || fact.predicate || fact.object_value)
        && (
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
        <div className="mb-3 pl-7 space-y-3">
          <div>
            <label
              className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
              htmlFor={`edit-subject-${factUid}`}
            >
              subject
            </label>
            <select
              id={`edit-subject-${factUid}`}
              data-testid={`fact-edit-subject-${factUid}`}
              value={currentSubject}
              onChange={(e) => emitEdit({ subject: e.target.value })}
              className={
                'w-full rounded-md border border-border-subtle bg-bg-elevated '
                + 'p-2 text-sm text-text-primary focus:outline-none '
                + 'focus:border-accent-cool'
              }
            >
              {/* Allow the current value even if it's not in objects (defensive) */}
              {!objects?.some((o) => o.uid === currentSubject) && (
                <option value={currentSubject}>
                  {currentSubject || '(unset)'}
                </option>
              )}
              {(objects ?? []).map((o) => (
                <option key={o.uid} value={o.uid}>
                  {(lang === 'en' && o.name_en) ? o.name_en : o.name}{' '}
                  ({o.uid})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
              htmlFor={`edit-predicate-${factUid}`}
            >
              predicate
            </label>
            <input
              id={`edit-predicate-${factUid}`}
              data-testid={`fact-edit-predicate-${factUid}`}
              type="text"
              value={currentPredicate}
              onChange={(e) => emitEdit({ predicate: e.target.value })}
              placeholder="snake_case_predicate"
              className={
                'w-full rounded-md border border-border-subtle bg-bg-elevated '
                + 'p-2 text-sm text-text-primary font-mono focus:outline-none '
                + 'focus:border-accent-cool'
              }
            />
          </div>
          <div>
            <label
              className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
              htmlFor={`edit-object-${factUid}`}
            >
              object
            </label>
            <input
              id={`edit-object-${factUid}`}
              data-testid={`fact-edit-object-${factUid}`}
              type="text"
              value={currentObject}
              list={`fact-edit-object-${factUid}-options`}
              onChange={(e) => emitEdit({ object: e.target.value })}
              placeholder="entity name or literal value"
              className={
                'w-full rounded-md border border-border-subtle bg-bg-elevated '
                + 'p-2 text-sm text-text-primary focus:outline-none '
                + 'focus:border-accent-cool'
              }
            />
            {objects && objects.length > 0 && (
              <datalist id={`fact-edit-object-${factUid}-options`}>
                {objects.map((o) => (
                  <option key={o.uid} value={o.name} />
                ))}
              </datalist>
            )}
          </div>
          <p className="text-xxs text-text-muted opacity-60 font-mono">
            preview: <span data-testid={`fact-edit-preview-${factUid}`}>{previewClaim}</span>
          </p>
          <p className="text-xxs text-text-muted">
            Original claim preserved as alias on the persisted FactNode (DR-036).
          </p>
        </div>
      )}
      <div className="flex gap-2 flex-wrap pl-7">
        <ActionButton
          variant="secondary"
          active={isEditing}
          onClick={() => emitEdit({})}
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
