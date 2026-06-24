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
    // decide-frontend-prefer-name: prefer the backend-corrected primary
    // surface (obj.name). Per feat/spo-decide-payload-wire, the backend
    // places the source-language verbatim surface here, including the
    // _match_object correction. The previous `lang === 'en'` branch
    // returned the LLM-raw name_en alias and masked that correction
    // (e.g. displaying "Ministry of Commerce of China" instead of
    // the corrected "중국 상무부"). name_en stays a valid fallback when
    // name is empty, and remains in ObjectSummary for cross-lingual
    // search consumers.
    return obj.name || obj.name_en || value;
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
    const id = setTimeout(() => {
      setDebounced(value);
      // decide-ux-v3 instrumentation (step 2): debounce fired
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.debug('[FactCard] debounce fired', { value, delay });
      }
    }, delay);
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
  // decide-ux-v3: suppress the initial auto-fetch when subjectQuery is just
  // the resolved label of the currently-selected subject. The first time the
  // user actually types in the input, this flips true and stays true.
  const [subjectUserTyped, setSubjectUserTyped] = useState(false);

  // Entity suggestion state — object
  const [objectQuery, setObjectQuery] = useState(() =>
    objectLabel !== '—' ? objectLabel : currentObject,
  );
  const [objectSuggestions, setObjectSuggestions] = useState<EntitySuggestion[]>([]);
  const debouncedObjectQuery = useDebounce(objectQuery, 200);
  const [objectUserTyped, setObjectUserTyped] = useState(false);

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
  // decide-ux-v3 instrumentation (steps 3-5): the gate condition values are
  // logged on every run; the fetch result is logged on resolve. Open DevTools
  // verbose console to trace the live path on each keystroke.
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard] subject fetch gate', {
        isEditing,
        debouncedSubjectQuery,
        spaceId,
        subjectUserTyped,
      });
    }
    if (!isEditing || !debouncedSubjectQuery.trim() || !spaceId || !subjectUserTyped) {
      setSubjectSuggestions([]);
      return;
    }
    let cancelled = false;
    const url = `/api/spaces/${spaceId}/entities/suggest?q=${encodeURIComponent(debouncedSubjectQuery)}&limit=5`;
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard] subject fetch fire', { url });
    }
    searchEntitySuggestions(debouncedSubjectQuery, spaceId, 5)
      .then((items) => {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.debug('[FactCard] subject fetch result', { cancelled, count: items.length, items });
        }
        if (!cancelled) setSubjectSuggestions(items);
      })
      .catch((err) => {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.debug('[FactCard] subject fetch error', err);
        }
        if (!cancelled) setSubjectSuggestions([]);
      });
    return () => { cancelled = true; };
  }, [debouncedSubjectQuery, isEditing, spaceId, subjectUserTyped]);

  // Fetch object suggestions
  useEffect(() => {
    if (!isEditing || !debouncedObjectQuery.trim() || !spaceId || !objectUserTyped) {
      setObjectSuggestions([]);
      return;
    }
    let cancelled = false;
    searchEntitySuggestions(debouncedObjectQuery, spaceId, 5)
      .then((items) => { if (!cancelled) setObjectSuggestions(items); })
      .catch(() => { if (!cancelled) setObjectSuggestions([]); });
    return () => { cancelled = true; };
  }, [debouncedObjectQuery, isEditing, spaceId, objectUserTyped]);

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
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard chip-click] 4. save payload', {
        subjectQuery,
        editedSubjectUid,
        currentSubject,
        editedPredicate,
        editedObjectValue,
      });
    }
    setEditFormOpen(false);
  };

  // decide-chip-click-bind: step 3 — post-state render. Logs the values that
  // actually landed in the DOM after the chip click batched-render. If step 2
  // fired but step 3 shows the old query, the bug is in the parent-sync
  // useEffect (line ~199 above).
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard chip-click] 3. post-state render', {
        subjectQuery,
        objectQuery,
        editedSubjectUid,
        editedObjectValue,
        currentSubject,
      });
    }
  }, [subjectQuery, objectQuery, editedSubjectUid, editedObjectValue, currentSubject]);

  // decide-chip-click-bind: LIVE click-path instrumentation. The 5-point
  // trace lets PO open DevTools verbose console and see the entire chain
  // each time a chip is clicked. Step 1 = click received here; step 2 =
  // state setters called; step 3 = post-state render (via useEffect below);
  // step 4 = save (in onSaveEdit); step 5 = submit (in DecideOverlay).
  const onSubjectChipClick = (suggestion: EntitySuggestion) => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard chip-click] 1. subject click received', {
        chip: suggestion,
      });
    }
    // Pre-arm prevSubjectRef so the parent-sync useEffect below does NOT
    // overwrite subjectQuery when editedSubjectUid lands. Without this,
    // the sync effect compares the new uid against the old subjectQuery
    // value and calls resolveEntity(uid) — which, for a fresh entity not
    // in the Decision objects labelMap, returns the raw uid (or the
    // "(unresolved)" marker), clobbering the chip's primary_label that
    // we just placed in the input. PO's "input reverts" repro.
    prevSubjectRef.current = suggestion.entity_id;
    setSubjectQuery(suggestion.primary_label);
    setSubjectSuggestions([]);
    setSubjectUserTyped(false); // chip-click selects an entity; suppress refetch
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard chip-click] 2. subject state setters called', {
        newSubjectQuery: suggestion.primary_label,
        newSubjectUid: suggestion.entity_id,
      });
    }
    emitEdit({ subject: suggestion.entity_id });
  };

  const onObjectChipClick = (suggestion: EntitySuggestion) => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard chip-click] 1. object click received', {
        chip: suggestion,
      });
    }
    // Same pre-arm pattern as subject — keep the input value the chip
    // label, not the unresolved uid.
    prevObjectRef.current = suggestion.entity_id;
    setObjectQuery(suggestion.primary_label);
    setObjectSuggestions([]);
    setObjectUserTyped(false);
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard chip-click] 2. object state setters called', {
        newObjectQuery: suggestion.primary_label,
        newObjectUid: suggestion.entity_id,
      });
    }
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
            {/* v0.2.0 step 1 (fact-claim-layer-v1) — CLAIM badge. The
                fact is a one-hop provenance utterance, NOT a current-
                event action. Lucid records "X said Y" but does not
                verify Y's truth. Action facts (fact_type='action' or
                undefined for legacy back-compat) render unchanged. */}
            {fact.fact_type === 'claim' && (
              <span
                data-testid={`fact-claim-badge-${factUid}`}
                className="inline-flex items-center text-xxs font-mono text-accent-cool bg-accent-cool/10 border border-accent-cool/30 rounded px-1.5 py-0.5"
                title="화자 인용 (one-hop provenance — 내용 진실은 보증되지 않음)"
              >
                CLAIM
              </span>
            )}
            {/* v0.2.0 step 2 (fact-measurement-layer-v1) — MEASUREMENT
                badge. The fact is a numeric value pinned to a timepoint
                (as_of). Same metric across multiple as_of → a verified
                time series — Lucid's structural moat over note-apps /
                LLM completion. Color is warm (vs cool CLAIM) so the
                two badges differentiate at a glance. */}
            {fact.fact_type === 'measurement' && (
              <span
                data-testid={`fact-measurement-badge-${factUid}`}
                className="inline-flex items-center text-xxs font-mono text-accent-warm bg-accent-warm/10 border border-accent-warm/30 rounded px-1.5 py-0.5"
                title="수치 측정 (numeric data pinned to a timepoint — 시계열의 한 점)"
              >
                MEASUREMENT
              </span>
            )}
            {/* decide-ux-v3: negation badge UI removed per PO ("필요 없다"). */}
            {/* The underlying fact.negation_flag + negation_scope data is */}
            {/* preserved on the FactNode in storage — kept as substrate for */}
            {/* future contradiction detection. UI surface only is removed. */}
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

      {/* v0.2.0 step 1 (fact-claim-layer-v1) — speaker / speech_act
          / content_claim strip. Only renders for claim facts; action
          cards are visually unchanged. Italic styling reflects the
          one-hop provenance nature ("X said Y", not "Y is true"). */}
      {!isEditing && fact.fact_type === 'claim'
        && (fact.speaker_label || fact.speech_act || fact.content_claim)
        && (
        <p
          data-testid={`fact-claim-strip-${factUid}`}
          className="text-sm text-text-secondary mb-3 pl-7 italic"
          lang={lang === 'kr' ? 'ko' : 'en'}
        >
          {fact.speaker_label && (
            <span className="font-medium not-italic">[{fact.speaker_label}]</span>
          )}
          {fact.speech_act && (
            <span className="ml-1 not-italic">&ldquo;{fact.speech_act}&rdquo;:</span>
          )}
          {fact.content_claim && (
            <span className="ml-1">{fact.content_claim}</span>
          )}
        </p>
      )}

      {/* v0.2.0 step 2 (fact-measurement-layer-v1) — metric / value /
          unit / as_of strip. Only renders for measurement facts.
          Format example: "[MEASUREMENT] MAU = 800,000,000 명 (2026-03)".
          Locale formatting (`toLocaleString`) puts thousands separators
          on the value so 8e8 reads as "800,000,000" not "800000000".
          Strict mono-font keeps the value-unit-timepoint alignment
          stable regardless of UI lang.

          v0.2.0 step 2.5 (feat/measurement-completeness, PO 2026-06-24):
          the explicit "[MEASUREMENT]" prefix establishes the strip as a
          derived chip-style summary, not a replacement for the original
          claim sentence rendered above (line 499). PO directive:
          surface = faithful, structure = metadata on top. The claim
          MUST coexist with the strip; the prefix makes the visual
          relationship unambiguous. */}
      {!isEditing && fact.fact_type === 'measurement'
        && (
          fact.metric
          || fact.measurement_value !== null && fact.measurement_value !== undefined
          || fact.measurement_unit
          || fact.as_of
        )
        && (
        <p
          data-testid={`fact-measurement-strip-${factUid}`}
          className="text-sm text-text-secondary mb-3 pl-7 font-mono"
          lang={lang === 'kr' ? 'ko' : 'en'}
        >
          <span
            data-testid={`fact-measurement-prefix-${factUid}`}
            className="mr-2 opacity-60"
          >
            [MEASUREMENT]
          </span>
          {fact.metric && (
            <span
              data-testid={`fact-measurement-metric-${factUid}`}
              className="font-medium text-accent-warm"
            >
              {fact.metric}
            </span>
          )}
          {(fact.measurement_value !== null && fact.measurement_value !== undefined) && (
            <>
              {fact.metric && <span className="mx-1 opacity-60">=</span>}
              <span data-testid={`fact-measurement-value-${factUid}`}>
                {Number(fact.measurement_value).toLocaleString()}
              </span>
            </>
          )}
          {fact.measurement_unit && (
            <span
              data-testid={`fact-measurement-unit-${factUid}`}
              className="ml-1"
            >
              {fact.measurement_unit}
            </span>
          )}
          {fact.as_of && (
            <span
              data-testid={`fact-measurement-asof-${factUid}`}
              className="ml-2 opacity-70"
            >
              ({fact.as_of})
            </span>
          )}
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
                // decide-ux-v3 instrumentation (step 1): subject onChange fired
                if (process.env.NODE_ENV === 'development') {
                  // eslint-disable-next-line no-console
                  console.debug('[FactCard] subject onChange', { val });
                }
                setSubjectQuery(val);
                setSubjectUserTyped(true);
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
                setObjectUserTyped(true);
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