'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { ActionButton } from './ActionButton';
import { GraphNoteEditor } from './GraphNoteEditor';
import { searchEntitySuggestions, listPredicates } from '@/lib/api';
import type { FactAction, FactSummary, ObjectSummary, EntitySuggestion, PredicateEntry } from '@/lib/types';
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
  objects?: ObjectSummary[];
  action: FactAction;
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

const OBJECT_REF_PATTERN = /^(?:obj-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function buildLabelMap(objects: ObjectSummary[] | undefined): Map<string, ObjectSummary> {
  const m = new Map<string, ObjectSummary>();
  if (!objects) return m;
  for (const o of objects) m.set(o.uid, o);
  return m;
}

function buildNameToUidMap(objects: ObjectSummary[] | undefined): Map<string, string> {
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

function regenerateClaim(subjectLabel: string, predicate: string, objectLabel: string): string {
  const s = subjectLabel || '?';
  const p = predicate || '?';
  const o = objectLabel || '?';
  return `${s} | ${p} | ${o}`;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
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
  const isEditMode = action === 'edit';
  const isDiscarded = action === 'discard';
  const isChecked = action !== 'discard';
  // decide-ux-fix #3: edit form open state is local. When the user
  // clicks 저장 we close the form while keeping the parent's
  // action='edit' (so editedSubjectUid/predicate/objectValue are
  // still submitted). 취소 reverts to action='accept' AND closes
  // the form. Re-clicking Edit while action='edit' re-opens it.
  const [editFormOpen, setEditFormOpen] = useState(isEditMode);
  useEffect(() => {
    // When the parent transitions out of edit (e.g. via the global
    // checkbox or discard toggle) keep the form closed for next
    // open. When the parent jumps INTO edit from non-edit, open it.
    if (!isEditMode) setEditFormOpen(false);
  }, [isEditMode]);
  const isEditing = isEditMode && editFormOpen;

  const labelMap = useMemo(() => buildLabelMap(objects), [objects]);
  const nameToUid = useMemo(() => buildNameToUidMap(objects), [objects]);

  const currentSubject = editedSubjectUid ?? fact.subject_uid ?? '';
  const currentPredicate = editedPredicate ?? fact.predicate ?? '';
  const currentObject = editedObjectValue ?? fact.object_value ?? '';

  const subjectLabel = resolveEntity(currentSubject, labelMap, lang);
  const objectLabel = resolveEntity(currentObject, labelMap, lang);

  const previewClaim = useMemo(
    () => regenerateClaim(subjectLabel, currentPredicate, objectLabel),
    [subjectLabel, currentPredicate, objectLabel],
  );

  // Entity suggestion state — subject
  const [subjectQuery, setSubjectQuery] = useState(() =>
    subjectLabel !== '—' ? subjectLabel : currentSubject,
  );
  const [subjectSuggestions, setSubjectSuggestions] = useState<EntitySuggestion[]>([]);
  const debouncedSubjectQuery = useDebounce(subjectQuery, 200);

  // Entity suggestion state — object
  const [objectQuery, setObjectQuery] = useState(() =>
    objectLabel !== '—' ? objectLabel : currentObject,
  );
  const [objectSuggestions, setObjectSuggestions] = useState<EntitySuggestion[]>([]);
  const debouncedObjectQuery = useDebounce(objectQuery, 200);

  // Predicate autocomplete state
  const [predicateQuery, setPredicateQuery] = useState(currentPredicate);
  const [predicateCache, setPredicateCache] = useState<PredicateEntry[]>([]);
  const predicateSuggestions = useMemo(() => {
    if (!predicateQuery.trim()) return [];
    const q = predicateQuery.toLowerCase();
    return predicateCache
      .filter(
        (p) =>
          p.code.toLowerCase().includes(q) ||
          p.label_ko.toLowerCase().includes(q) ||
          p.label_en.toLowerCase().includes(q),
      )
      .slice(0, 5);
  }, [predicateQuery, predicateCache]);

  // Load predicate cache on mount when editing
  useEffect(() => {
    if (!isEditing) return;
    listPredicates()
      .then(setPredicateCache)
      .catch(() => {/* degrade quietly */});
  }, [isEditing]);

  // Sync inputs when parent-controlled values change
  const prevSubjectRef = useRef(currentSubject);
  const prevObjectRef = useRef(currentObject);
  const prevPredicateRef = useRef(currentPredicate);
  useEffect(() => {
    if (currentSubject !== prevSubjectRef.current) {
      prevSubjectRef.current = currentSubject;
      const resolved = resolveEntity(currentSubject, labelMap, lang);
      setSubjectQuery(resolved !== '—' ? resolved : currentSubject);
    }
  }, [currentSubject, labelMap, lang]);
  useEffect(() => {
    if (currentObject !== prevObjectRef.current) {
      prevObjectRef.current = currentObject;
      const resolved = resolveEntity(currentObject, labelMap, lang);
      setObjectQuery(resolved !== '—' ? resolved : currentObject);
    }
  }, [currentObject, labelMap, lang]);
  useEffect(() => {
    if (currentPredicate !== prevPredicateRef.current) {
      prevPredicateRef.current = currentPredicate;
      setPredicateQuery(currentPredicate);
    }
  }, [currentPredicate]);

  // Fetch subject suggestions
  useEffect(() => {
    if (!isEditing || !debouncedSubjectQuery.trim() || !spaceId) {
      setSubjectSuggestions([]);
      return;
    }
    let cancelled = false;
    searchEntitySuggestions(debouncedSubjectQuery, spaceId, 5)
      .then((items) => { if (!cancelled) setSubjectSuggestions(items); })
      .catch(() => { if (!cancelled) setSubjectSuggestions([]); });
    return () => { cancelled = true; };
  }, [debouncedSubjectQuery, isEditing, spaceId]);

  // Fetch object suggestions
  useEffect(() => {
    if (!isEditing || !debouncedObjectQuery.trim() || !spaceId) {
      setObjectSuggestions([]);
      return;
    }
    let cancelled = false;
    searchEntitySuggestions(debouncedObjectQuery, spaceId, 5)
      .then((items) => { if (!cancelled) setObjectSuggestions(items); })
      .catch(() => { if (!cancelled) setObjectSuggestions([]); });
    return () => { cancelled = true; };
  }, [debouncedObjectQuery, isEditing, spaceId]);

  // Emit helpers
  const emitEdit = (next: { subject?: string; predicate?: string; object?: string }) => {
    const nextSubject = next.subject ?? currentSubject;
    const nextPredicate = next.predicate ?? currentPredicate;
    const nextObject = next.object ?? currentObject;
    const resolvedObject = nameToUid.get(nextObject) ?? nextObject;
    const nextSubjectLabel = resolveEntity(nextSubject, labelMap, lang);
    const nextObjectLabel = resolveEntity(resolvedObject, labelMap, lang);
    const nextClaim = regenerateClaim(nextSubjectLabel, nextPredicate, nextObjectLabel);
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
          ? { action: 'edit', editedClaim, editedSubjectUid, editedPredicate, editedObjectValue }
          : { action: 'accept' },
      );
    }
  };

  // Discard toggle: when already discarded, clicking '취소' reverts
  const onDiscardToggle = () => {
    if (isDiscarded) {
      onChange(
        editedClaim
          ? { action: 'edit', editedClaim, editedSubjectUid, editedPredicate, editedObjectValue }
          : { action: 'accept' },
      );
    } else {
      onChange({ action: 'discard' });
    }
  };

  const onCancelEdit = () => {
    setEditFormOpen(false);
    onChange({ action: 'accept' });
  };

  const onEditClick = () => {
    if (isEditMode) {
      // already in edit; toggle form visibility (acts as a re-open)
      setEditFormOpen((prev) => !prev);
    } else {
      emitEdit({});
      setEditFormOpen(true);
    }
  };

  const onSaveEdit = () => {
    // Keep action='edit' so the parent retains editedSubjectUid /
    // editedPredicate / editedObjectValue for the batch submit.
    // Just close the local form.
    setEditFormOpen(false);
  };

  const onSubjectChipClick = (suggestion: EntitySuggestion) => {
    setSubjectQuery(suggestion.primary_label);
    setSubjectSuggestions([]);
    emitEdit({ subject: suggestion.entity_id });
  };

  const onObjectChipClick = (suggestion: EntitySuggestion) => {
    setObjectQuery(suggestion.primary_label);
    setObjectSuggestions([]);
    emitEdit({ object: suggestion.entity_id });
  };

  const onPredicateChipClick = (entry: PredicateEntry) => {
    setPredicateQuery(entry.code);
    emitEdit({ predicate: entry.code });
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
          <div className="flex items-center gap-2">
            {isDiscarded && (
              <span className="inline-flex items-center text-xxs font-mono text-accent-error bg-accent-error/10 border border-accent-error/30 rounded px-1.5 py-0.5">
                폐기 예정
              </span>
            )}
            {fact.negation_flag && (
              <span
                className="inline-flex items-center gap-1 text-xxs text-accent-error"
                aria-label="부정 진술"
                role="status"
                title="이 사실은 '~할 수 없다 / 금지 / ~지 않다' 를 담은 부정 진술입니다."
                data-testid={`fact-negation-${factUid}`}
              >
                ⚠ 부정 진술
              </span>
            )}
          </div>
        </div>
      </header>

      {isEditing && (
        <blockquote className="italic text-sm text-text-secondary mb-3 pl-7 border-l-2 border-border-subtle">
          &ldquo;{displayClaim(fact, lang)}&rdquo;
        </blockquote>
      )}

      {!isEditing && (
        <p
          className={['text-base mb-3 pl-7', isDiscarded ? 'line-through' : ''].join(' ')}
          lang={lang === 'kr' ? 'ko' : 'en'}
          data-testid={`fact-claim-${factUid}`}
        >
          {/* decide-ux-v2 (4): claim is the ORIGINAL sentence; never */}
          {/* replace with the S|P|O pipe-joined reconstruction. The */}
          {/* edited triple surfaces in the S/P/O dl below. */}
          {displayClaim(fact, lang)}
        </p>
      )}

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
            <dd data-testid="fact-predicate">{currentPredicate || '—'}</dd>
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
            <input
              id={`edit-subject-${factUid}`}
              data-testid={`fact-edit-subject-${factUid}`}
              type="text"
              value={subjectQuery}
              onChange={(e) => {
                const val = e.target.value;
                setSubjectQuery(val);
                emitEdit({ subject: val });
              }}
              placeholder="entity name or uid"
              className={
                'w-full rounded-md border border-border-subtle bg-bg-elevated '
                + 'p-2 text-sm text-text-primary focus:outline-none '
                + 'focus:border-accent-cool'
              }
            />
            {subjectSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {subjectSuggestions.map((s) => (
                  <button
                    key={s.entity_id}
                    type="button"
                    onClick={() => onSubjectChipClick(s)}
                    data-testid={`subject-chip-${s.entity_id}`}
                    className="text-xxs rounded border border-accent-cool/40 bg-accent-cool/10 px-2 py-0.5 text-accent-cool hover:bg-accent-cool/20 font-mono"
                  >
                    → {s.primary_label} [{s.primary_lang}]
                  </button>
                ))}
              </div>
            )}
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
              value={predicateQuery}
              onChange={(e) => {
                const val = e.target.value;
                setPredicateQuery(val);
                emitEdit({ predicate: val });
              }}
              placeholder="snake_case_predicate"
              className={
                'w-full rounded-md border border-border-subtle bg-bg-elevated '
                + 'p-2 text-sm text-text-primary font-mono focus:outline-none '
                + 'focus:border-accent-cool'
              }
            />
            {predicateSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {predicateSuggestions.map((p) => (
                  <button
                    key={p.code}
                    type="button"
                    onClick={() => onPredicateChipClick(p)}
                    data-testid={`predicate-chip-${p.code}`}
                    className="text-xxs rounded border border-accent-cool/40 bg-accent-cool/10 px-2 py-0.5 text-accent-cool hover:bg-accent-cool/20 font-mono"
                  >
                    {p.label_ko} / {p.label_en} ({p.code})
                  </button>
                ))}
              </div>
            )}
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
              value={objectQuery}
              onChange={(e) => {
                const val = e.target.value;
                setObjectQuery(val);
                emitEdit({ object: val });
              }}
              placeholder="entity name or literal value"
              className={
                'w-full rounded-md border border-border-subtle bg-bg-elevated '
                + 'p-2 text-sm text-text-primary focus:outline-none '
                + 'focus:border-accent-cool'
              }
            />
            {objectSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {objectSuggestions.map((s) => (
                  <button
                    key={s.entity_id}
                    type="button"
                    onClick={() => onObjectChipClick(s)}
                    data-testid={`object-chip-${s.entity_id}`}
                    className="text-xxs rounded border border-accent-cool/40 bg-accent-cool/10 px-2 py-0.5 text-accent-cool hover:bg-accent-cool/20 font-mono"
                  >
                    → {s.primary_label} [{s.primary_lang}]
                  </button>
                ))}
              </div>
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

      <div className="flex gap-2 flex-wrap pl-7 items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          <ActionButton
            variant="secondary"
            active={isEditing}
            onClick={onEditClick}
            disabled={isDiscarded}
          >
            Edit
          </ActionButton>
          <ActionButton
            variant={isDiscarded ? 'danger' : 'ghost'}
            active={isDiscarded}
            onClick={onDiscardToggle}
          >
            {isDiscarded ? '취소' : 'Discard'}
          </ActionButton>
        </div>
        {isEditing && (
          <div className="flex gap-2">
            <ActionButton
              variant="ghost"
              onClick={onCancelEdit}
            >
              취소
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={onSaveEdit}
              data-testid={`fact-save-${factUid}`}
            >
              저장
            </ActionButton>
          </div>
        )}
      </div>
      {reviewMode && spaceId && (
        <GraphNoteEditor spaceId={spaceId} factUid={factUid} />
      )}
    </article>
  );
}