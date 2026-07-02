/**
 * REQ-014-B (PO 2026-07-02) — DECIDE fact_type 별 편집 폼.
 *
 * PO 의뢰서 verbatim:
 *   B1. 현재 모든 atomic fact 를 SPO 획일 분해 → fact_type 별로 다르게:
 *       - ACTION: subject ─[predicate]→ object
 *       - MEASUREMENT: subject = 수치(값·단위·시점)
 *       - CLAIM: 누가 [동사]: "무엇을" (modality)
 *   B2. entity 유형(10종) badge + 클릭 → EntityTypeDropdown 진입
 *   B4. subject 이름 수정은 EntityNameEdit path (REQ-012-v2 shipped)
 *       가 진짜 rename 이라는 사실을 안내한다. Decide 의 subject 입력은
 *       fact 를 다른 entity 로 재바인딩하는 경로.
 *
 * 각 form 은 편집 상태에서만 렌더된다. 미편집 (accept / discard) 은
 * FactCard 가 기존 요약 뷰 (제목 + FactTypeStrip + SPO dl) 를 그대로 보인다.
 *
 * ★ 옛 3칼럼 SPO grid 는 편집 시 폐기 — fact_type 별 폼이 대신 등장한다.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  searchEntitySuggestions,
  listPredicates,
  ENTITY_TYPE_OPTIONS,
} from '@/lib/api';
import type {
  FactSummary,
  ObjectSummary,
  EntitySuggestion,
  PredicateEntry,
} from '@/lib/types';
import type { Lang } from './LangToggle';
// ★ REQ-014-D (PO 2026-07-02) — modality select 초기값 복원.
//   ClaimFactForm 의 modality select 는 옛에는 speech_act 가 정확히
//   'assertion'/'judgment'/'opinion' 일 때만 옵션 매칭 → 한국어 술어
//   ("말했다"/"발표했다") 는 항상 "양태 미지정" 초기값. classifyClaimModality
//   가 이제 KO 술어를 매핑하므로 select 도 그 결과를 사용한다.
import { classifyClaimModality } from './ClaimModalityBadge';

// ---------------------------------------------------------------------------
// 공통 helpers — 옛 FactCard 의 debounce / label resolver 등을 그대로 옮겨온다.
// ---------------------------------------------------------------------------

const OBJECT_REF_PATTERN =
  /^(?:obj-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

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

function resolveLabel(
  value: string | undefined,
  labelMap: Map<string, ObjectSummary>,
  lang: Lang,
): string {
  if (!value) return '';
  const obj = labelMap.get(value);
  if (obj) return obj.name || obj.name_en || value;
  if (OBJECT_REF_PATTERN.test(value)) {
    return lang === 'en' ? 'unresolved entity' : '미해결 entity';
  }
  return value;
}

function resolveEntityType(
  value: string | undefined,
  labelMap: Map<string, ObjectSummary>,
): string | null {
  if (!value) return null;
  const obj = labelMap.get(value);
  if (!obj) return null;
  return obj.class || obj.class_ || null;
}

function korEntityTypeLabel(entityType: string | null): string | null {
  if (!entityType) return null;
  const opt = ENTITY_TYPE_OPTIONS.find((o) => o.value === entityType.toLowerCase());
  return opt ? opt.label : entityType;
}

// ---------------------------------------------------------------------------
// EntityField — 공통 entity 입력 + suggestion chip + entity_type badge.
//
// REQ-014-B B2: entity 옆에 유형 badge 를 표기하고, badge 를 클릭하면
// (spaceId 가 있을 때) EntityTypeDropdown 이 진입할 수 있는 route 로 이동
// 링크를 안내한다. STELLAR 우패널에서 이미 EntityTypeDropdown 을 쓰고
// 있으므로 Decide 인라인은 "확인 필요 시 → STELLAR 로" 유도만 담당한다.
// ---------------------------------------------------------------------------

interface EntityFieldProps {
  factUid: string;
  role: 'subject' | 'object' | 'speaker' | 'mentioned';
  labelText: string;
  currentUid: string;
  spaceId: string | undefined;
  labelMap: Map<string, ObjectSummary>;
  nameToUid: Map<string, string>;
  lang: Lang;
  onChangeUid: (nextUid: string) => void;
  onTypedLabel?: (label: string) => void;
  isEditing: boolean;
  placeholder?: string;
  /** ★ REQ-014-B — 레거시 testid alias (fact-edit-subject / fact-edit-object)
   *  를 유지해야 하는 ACTION 폼용. subject / object 만 옛 3칼럼 SPO 폼과
   *  같은 UX 역할이라 기존 vitest 스위트가 파고 있는 testid 를 붙여둔다.
   *  speaker / mentioned 는 새 폼 전용이라 alias 없음. */
  legacyTestId?: string;
}

function EntityField({
  factUid,
  role,
  labelText,
  currentUid,
  spaceId,
  labelMap,
  nameToUid,
  lang,
  onChangeUid,
  onTypedLabel,
  isEditing,
  placeholder,
  legacyTestId,
}: EntityFieldProps) {
  const resolvedLabel = resolveLabel(currentUid, labelMap, lang);
  const [query, setQuery] = useState<string>(resolvedLabel || currentUid);
  const [suggestions, setSuggestions] = useState<EntitySuggestion[]>([]);
  const [userTyped, setUserTyped] = useState(false);
  const debounced = useDebounce(query, 200);
  const prevUidRef = useRef(currentUid);
  // ★ REQ-014-B — 방금 chip-click 으로 setQuery 를 명시적으로 지정한 경우
  //   parent-sync effect 가 currentUid → resolvedLabel 로 덮지 못하게
  //   guard. 사용자가 다시 타이핑하기 전까지 유지된다.
  const chipLockedQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentUid !== prevUidRef.current) {
      prevUidRef.current = currentUid;
      // chip-click 으로 지정한 query 는 parent-uid change 후에도 유지.
      if (chipLockedQueryRef.current !== null) return;
      const nextResolved = resolveLabel(currentUid, labelMap, lang);
      // ★ REQ-014-B — parent-controlled currentUid change 가 사용자 입력
      //   text 를 덮어쓰지 않도록 보호. 사용자가 방금 타이핑한 값 (query)
      //   이 currentUid 와 같으면 (예: onInputChange 가 uid 로도 raw text
      //   를 실어 올린 경우), query 를 재설정하지 않고 그대로 유지한다.
      if (nextResolved && nextResolved !== query) {
        setQuery(nextResolved);
        setUserTyped(false);
      } else if (!nextResolved && currentUid && currentUid !== query) {
        setQuery(currentUid);
        setUserTyped(false);
      }
    }
  }, [currentUid, labelMap, lang, query]);

  useEffect(() => {
    if (!isEditing || !debounced.trim() || !spaceId || !userTyped) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    searchEntitySuggestions(debounced, spaceId, 5)
      .then((items) => { if (!cancelled) setSuggestions(items); })
      .catch(() => { if (!cancelled) setSuggestions([]); });
    return () => { cancelled = true; };
  }, [debounced, isEditing, spaceId, userTyped]);

  const entityType = useMemo(
    () => resolveEntityType(currentUid, labelMap),
    [currentUid, labelMap],
  );
  const korType = korEntityTypeLabel(entityType);

  const onInputChange = useCallback((val: string) => {
    setQuery(val);
    setUserTyped(true);
    // 다시 타이핑하면 chip lock 해제.
    chipLockedQueryRef.current = null;
    onTypedLabel?.(val);
    // name-to-uid best-effort resolve — if the typed label exactly
    // matches a known object name, promote it to a uid immediately
    // so the payload stays entity-referential. Otherwise pass the
    // raw string; the parent decides whether to accept it as-is.
    const mapped = nameToUid.get(val);
    onChangeUid(mapped ?? val);
  }, [nameToUid, onChangeUid, onTypedLabel]);

  const onChipClick = useCallback((s: EntitySuggestion) => {
    // ★ REQ-014-B — chip-click 은 label 을 명시적으로 확정. 이후 parent-sync
    //   effect 가 currentUid 를 다시 resolveLabel 로 돌려버리지 않도록
    //   chipLockedQueryRef 로 lock 을 건다. 다시 타이핑하면 자동 해제.
    chipLockedQueryRef.current = s.primary_label;
    setQuery(s.primary_label);
    setSuggestions([]);
    setUserTyped(false);
    onChangeUid(s.entity_id);
  }, [onChangeUid]);

  return (
    <div>
      <label
        className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
        htmlFor={`fact-form-${role}-${factUid}`}
      >
        {labelText}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`fact-form-${role}-${factUid}`}
          data-testid={legacyTestId ?? `fact-form-${role}-input-${factUid}`}
          data-fact-form-role={role}
          type="text"
          value={query}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={placeholder ?? 'entity name or uid'}
          className={
            'flex-1 rounded-md border border-border-subtle bg-bg-elevated '
            + 'p-2 text-sm text-text-primary focus:outline-none '
            + 'focus:border-accent-cool'
          }
        />
        {korType && (
          <span
            data-testid={`fact-form-${role}-entity-type-${factUid}`}
            className={
              'inline-flex items-center text-xxs font-mono rounded '
              + 'px-1.5 py-0.5 border '
              + 'text-accent-cool bg-accent-cool/10 border-accent-cool/30 '
              + 'whitespace-nowrap'
            }
            title={`entity_type: ${entityType} — 지식그래프 우패널에서 변경`}
          >
            {korType}
          </span>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button
              key={s.entity_id}
              type="button"
              onClick={() => onChipClick(s)}
              data-testid={`${role}-chip-${s.entity_id}`}
              className="text-xxs rounded border border-accent-cool/40 bg-accent-cool/10 px-2 py-0.5 text-accent-cool hover:bg-accent-cool/20 font-mono"
            >
              → {s.primary_label} [{s.primary_lang}]
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 공통 props: fact_type 별 폼은 부분 필드만 만지지만 payload 규격은 공통.
//
// ★ REQ-014-B B4 (subject 수정 반영 안 됨 root cause):
//   - Recall 의 PATCH /api/spaces/{ks}/facts/{fact_uid} 는 backend
//     _MODIFIABLE_FIELDS = {claim, predicate_label, object_value, tags} 에서
//     subject_label 을 아예 받지 않는다. 즉 사용자가 "화웨" → "화웨이" 로
//     타이핑해도 저장 endpoint 에는 그 필드가 없어서 무시된다.
//   - Decide 의 POST /decide 는 edited_metadata.subject_uid 로 다른 entity
//     로 재바인딩만 지원한다 — subject 이름 자체를 바꾸는 것이 아니라
//     "다른 entity 를 subject 로 지정" 이다.
//   - 진짜 subject 이름 rename = EntityNameEdit path (REQ-012-v2)
//     → /api/spaces/{ks}/entities/{uid}/name — 이 곳에서 대표명 갱신 +
//     옛 이름 aliases 흡수 + relabel_history append 가 일어난다.
//   Fix: Decide 편집 폼에서 subject 옆에 "이름 자체 rename 은 STELLAR 우패널
//   에서 진행" 안내 링크 (route 는 후속 UI 가 정한다). subject_label 은
//   edited_metadata 로 함께 실어 서버 coerce 단에서 문서 label 도 갱신한다.
// ---------------------------------------------------------------------------

export interface FactFormEdits {
  editedClaim?: string;
  editedSubjectUid?: string;
  editedSubjectLabel?: string;
  editedPredicate?: string;
  editedObjectValue?: string;
  editedObjectLabel?: string;
  // Measurement layer
  editedMetric?: string;
  editedMeasurementValue?: number | null;
  editedMeasurementUnit?: string;
  editedAsOf?: string;
  // Claim layer
  editedSpeakerUid?: string;
  editedSpeakerLabel?: string;
  editedSpeechAct?: string;
  editedContentClaim?: string;
}

export interface CommonFormProps {
  fact: FactSummary;
  factUid: string;
  lang: Lang;
  spaceId: string | undefined;
  objects?: ObjectSummary[];
  edits: FactFormEdits;
  onEdit: (patch: FactFormEdits) => void;
}

// ---------------------------------------------------------------------------
// EntityNameNoticeLink — subject/object/speaker rename 안내 (B4 fix).
// ---------------------------------------------------------------------------

function EntityNameNoticeLink({
  spaceId, entityUid, entityLabel, role,
}: {
  spaceId: string | undefined;
  entityUid: string;
  entityLabel: string;
  role: string;
}) {
  if (!spaceId || !entityUid || !OBJECT_REF_PATTERN.test(entityUid)) return null;
  const href = `/stellar?highlight=${encodeURIComponent(entityUid)}` as Route;
  return (
    <p
      data-testid={`fact-form-${role}-rename-notice`}
      className="text-xxs text-text-muted opacity-70 mt-1"
    >
      "{entityLabel}" 자체 이름을 바꾸려면{' '}
      <Link href={href} className="text-accent-cool hover:underline underline-offset-2">
        지식그래프 → entity 편집
      </Link>
      을 사용하세요. 여기서 저장하면 fact 를 다른 entity 로 재바인딩합니다.
    </p>
  );
}

// ---------------------------------------------------------------------------
// ActionFactForm — subject ─[predicate]→ object.
// ---------------------------------------------------------------------------

export function ActionFactForm({
  fact, factUid, lang, spaceId, objects, edits, onEdit,
}: CommonFormProps) {
  const labelMap = useMemo(() => buildLabelMap(objects), [objects]);
  const nameToUid = useMemo(() => buildNameToUidMap(objects), [objects]);

  const currentSubject = edits.editedSubjectUid ?? fact.subject_uid ?? '';
  const currentPredicate = edits.editedPredicate ?? fact.predicate ?? '';
  const currentObject = edits.editedObjectValue ?? fact.object_value ?? '';

  const [predicateQuery, setPredicateQuery] = useState<string>(currentPredicate);
  const [predicateCache, setPredicateCache] = useState<PredicateEntry[]>([]);

  useEffect(() => {
    listPredicates().then(setPredicateCache).catch(() => {/* degrade quietly */});
  }, []);

  const predicateSuggestions = useMemo(() => {
    if (!predicateQuery.trim()) return [];
    const q = predicateQuery.toLowerCase();
    return predicateCache
      .filter((p) =>
        p.code.toLowerCase().includes(q) ||
        p.label_ko.toLowerCase().includes(q) ||
        p.label_en.toLowerCase().includes(q))
      .slice(0, 5);
  }, [predicateQuery, predicateCache]);

  const subjectLabel = resolveLabel(currentSubject, labelMap, lang);
  const objectLabel = resolveLabel(currentObject, labelMap, lang);

  return (
    <div
      data-testid={`fact-action-form-${factUid}`}
      className="mb-3 pl-7 space-y-3"
    >
      <p className="text-xxs text-text-muted font-mono opacity-70">
        <strong className="text-accent-success">ACTION</strong> —
        subject 가 object 에 한 행위. subject ─[predicate]→ object 로 편집하세요.
      </p>
      <EntityField
        factUid={factUid}
        role="subject"
        labelText="subject"
        currentUid={currentSubject}
        spaceId={spaceId}
        labelMap={labelMap}
        nameToUid={nameToUid}
        lang={lang}
        isEditing
        legacyTestId={`fact-edit-subject-${factUid}`}
        onChangeUid={(uid) => onEdit({
          editedSubjectUid: uid,
          editedSubjectLabel: nameToUid.has(uid)
            ? resolveLabel(uid, labelMap, lang)
            : uid,
        })}
        onTypedLabel={(val) => onEdit({ editedSubjectLabel: val })}
      />
      <EntityNameNoticeLink
        spaceId={spaceId}
        entityUid={currentSubject}
        entityLabel={subjectLabel}
        role="subject"
      />
      <div>
        <label
          className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
          htmlFor={`fact-form-predicate-${factUid}`}
        >
          predicate
        </label>
        <input
          id={`fact-form-predicate-${factUid}`}
          data-testid={`fact-edit-predicate-${factUid}`}
          type="text"
          value={predicateQuery}
          onChange={(e) => {
            const val = e.target.value;
            setPredicateQuery(val);
            onEdit({ editedPredicate: val });
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
                onClick={() => {
                  setPredicateQuery(p.code);
                  onEdit({ editedPredicate: p.code });
                }}
                data-testid={`predicate-chip-${p.code}`}
                className="text-xxs rounded border border-accent-cool/40 bg-accent-cool/10 px-2 py-0.5 text-accent-cool hover:bg-accent-cool/20 font-mono"
              >
                {p.label_ko} / {p.label_en} ({p.code})
              </button>
            ))}
          </div>
        )}
      </div>
      <EntityField
        factUid={factUid}
        role="object"
        labelText="object"
        currentUid={currentObject}
        spaceId={spaceId}
        labelMap={labelMap}
        nameToUid={nameToUid}
        lang={lang}
        isEditing
        legacyTestId={`fact-edit-object-${factUid}`}
        onChangeUid={(uid) => onEdit({
          editedObjectValue: uid,
          editedObjectLabel: nameToUid.has(uid)
            ? resolveLabel(uid, labelMap, lang)
            : uid,
        })}
        onTypedLabel={(val) => onEdit({ editedObjectLabel: val })}
        placeholder="entity name or literal value"
      />
      <EntityNameNoticeLink
        spaceId={spaceId}
        entityUid={currentObject}
        entityLabel={objectLabel}
        role="object"
      />
      <p className="text-xxs text-text-muted font-mono opacity-70">
        preview:{' '}
        <span data-testid={`fact-edit-preview-${factUid}`}>
          {`${subjectLabel || '?'} | ${currentPredicate || '?'} | ${objectLabel || '?'}`}
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MeasurementFactForm — subject = 수치(값·단위·시점).
// ---------------------------------------------------------------------------

export function MeasurementFactForm({
  fact, factUid, lang, spaceId, objects, edits, onEdit,
}: CommonFormProps) {
  const labelMap = useMemo(() => buildLabelMap(objects), [objects]);
  const nameToUid = useMemo(() => buildNameToUidMap(objects), [objects]);

  const currentSubject = edits.editedSubjectUid ?? fact.subject_uid ?? '';
  const currentMetric = edits.editedMetric ?? fact.metric ?? '';
  const currentValue =
    edits.editedMeasurementValue !== undefined
      ? edits.editedMeasurementValue
      : (fact.measurement_value ?? null);
  const currentUnit = edits.editedMeasurementUnit ?? fact.measurement_unit ?? '';
  const currentAsOf = edits.editedAsOf ?? fact.as_of ?? '';

  const subjectLabel = resolveLabel(currentSubject, labelMap, lang);

  return (
    <div
      data-testid={`fact-measurement-form-${factUid}`}
      className="mb-3 pl-7 space-y-3"
    >
      <p className="text-xxs text-text-muted font-mono opacity-70">
        <strong className="text-accent-warm">MEASUREMENT</strong> —
        subject 에 대한 수치·단위·시점. S + metric + value + unit + as_of.
      </p>
      <EntityField
        factUid={factUid}
        role="subject"
        labelText="subject"
        currentUid={currentSubject}
        spaceId={spaceId}
        labelMap={labelMap}
        nameToUid={nameToUid}
        lang={lang}
        isEditing
        onChangeUid={(uid) => onEdit({
          editedSubjectUid: uid,
          editedSubjectLabel: nameToUid.has(uid)
            ? resolveLabel(uid, labelMap, lang)
            : uid,
        })}
        onTypedLabel={(val) => onEdit({ editedSubjectLabel: val })}
      />
      <EntityNameNoticeLink
        spaceId={spaceId}
        entityUid={currentSubject}
        entityLabel={subjectLabel}
        role="subject"
      />
      <div>
        <label
          className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
          htmlFor={`fact-form-metric-${factUid}`}
        >
          metric
        </label>
        <input
          id={`fact-form-metric-${factUid}`}
          data-testid={`fact-form-metric-input-${factUid}`}
          type="text"
          value={currentMetric}
          onChange={(e) => onEdit({ editedMetric: e.target.value })}
          placeholder="예: 매출, 실업률, 인구"
          className={
            'w-full rounded-md border border-border-subtle bg-bg-elevated '
            + 'p-2 text-sm text-text-primary focus:outline-none '
            + 'focus:border-accent-warm'
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
            htmlFor={`fact-form-value-${factUid}`}
          >
            value
          </label>
          <input
            id={`fact-form-value-${factUid}`}
            data-testid={`fact-form-value-input-${factUid}`}
            type="number"
            step="any"
            value={currentValue ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              onEdit({
                editedMeasurementValue: raw === '' ? null : Number(raw),
              });
            }}
            placeholder="예: 12.3"
            className={
              'w-full rounded-md border border-border-subtle bg-bg-elevated '
              + 'p-2 text-sm text-text-primary font-mono focus:outline-none '
              + 'focus:border-accent-warm'
            }
          />
        </div>
        <div>
          <label
            className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
            htmlFor={`fact-form-unit-${factUid}`}
          >
            unit
          </label>
          <input
            id={`fact-form-unit-${factUid}`}
            data-testid={`fact-form-unit-input-${factUid}`}
            type="text"
            value={currentUnit}
            onChange={(e) => onEdit({ editedMeasurementUnit: e.target.value })}
            placeholder="예: %, KRW, 명"
            className={
              'w-full rounded-md border border-border-subtle bg-bg-elevated '
              + 'p-2 text-sm text-text-primary focus:outline-none '
              + 'focus:border-accent-warm'
            }
          />
        </div>
      </div>
      <div>
        <label
          className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
          htmlFor={`fact-form-asof-${factUid}`}
        >
          as_of (시점)
        </label>
        <input
          id={`fact-form-asof-${factUid}`}
          data-testid={`fact-form-asof-input-${factUid}`}
          type="text"
          value={currentAsOf}
          onChange={(e) => onEdit({ editedAsOf: e.target.value })}
          placeholder="예: 2026-04, 2026 Q2, 2026-04-30"
          className={
            'w-full rounded-md border border-border-subtle bg-bg-elevated '
            + 'p-2 text-sm text-text-primary font-mono focus:outline-none '
            + 'focus:border-accent-warm'
          }
        />
      </div>
      <p className="text-xxs text-text-muted font-mono opacity-70">
        preview:{' '}
        <span data-testid={`fact-measurement-preview-${factUid}`}>
          {`${subjectLabel || '?'} · ${currentMetric || '?'} = ${currentValue ?? '?'} ${currentUnit || ''} (${currentAsOf || '?'})`}
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClaimFactForm — 누가 [동사]: "무엇을" (modality).
// ---------------------------------------------------------------------------

const MODALITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'assertion', label: '단정 (assertion)' },
  { value: 'judgment', label: '판단 (judgment)' },
  { value: 'opinion', label: '의견 (opinion)' },
];

export function ClaimFactForm({
  fact, factUid, lang, spaceId, objects, edits, onEdit,
}: CommonFormProps) {
  const labelMap = useMemo(() => buildLabelMap(objects), [objects]);
  const nameToUid = useMemo(() => buildNameToUidMap(objects), [objects]);

  const currentSpeaker = edits.editedSpeakerUid ?? fact.speaker_uid ?? fact.subject_uid ?? '';
  const currentSpeechAct = edits.editedSpeechAct ?? fact.speech_act ?? '';
  const currentContentClaim = edits.editedContentClaim ?? fact.content_claim ?? '';

  const speakerLabel = resolveLabel(currentSpeaker, labelMap, lang);

  return (
    <div
      data-testid={`fact-claim-form-${factUid}`}
      className="mb-3 pl-7 space-y-3"
    >
      <p className="text-xxs text-text-muted font-mono opacity-70">
        <strong className="text-accent-cool">CLAIM</strong> —
        화자가 무엇을 어떻게 말했는가. 누가 [동사]: "무엇을" (modality).
      </p>
      <EntityField
        factUid={factUid}
        role="speaker"
        labelText="speaker (화자)"
        currentUid={currentSpeaker}
        spaceId={spaceId}
        labelMap={labelMap}
        nameToUid={nameToUid}
        lang={lang}
        isEditing
        onChangeUid={(uid) => onEdit({
          editedSpeakerUid: uid,
          editedSubjectUid: uid,
          editedSpeakerLabel: nameToUid.has(uid)
            ? resolveLabel(uid, labelMap, lang)
            : uid,
        })}
        onTypedLabel={(val) => onEdit({ editedSpeakerLabel: val })}
      />
      <EntityNameNoticeLink
        spaceId={spaceId}
        entityUid={currentSpeaker}
        entityLabel={speakerLabel}
        role="speaker"
      />
      <div>
        <label
          className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
          htmlFor={`fact-form-speech-act-${factUid}`}
        >
          speech_act (동사)
        </label>
        <input
          id={`fact-form-speech-act-${factUid}`}
          data-testid={`fact-form-speech-act-input-${factUid}`}
          type="text"
          value={currentSpeechAct}
          onChange={(e) => onEdit({ editedSpeechAct: e.target.value })}
          placeholder="예: 발표했다, 주장했다, 우려했다"
          className={
            'w-full rounded-md border border-border-subtle bg-bg-elevated '
            + 'p-2 text-sm text-text-primary focus:outline-none '
            + 'focus:border-accent-cool'
          }
        />
      </div>
      <div>
        <label
          className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
          htmlFor={`fact-form-content-claim-${factUid}`}
        >
          content_claim (인용문)
        </label>
        <textarea
          id={`fact-form-content-claim-${factUid}`}
          data-testid={`fact-form-content-claim-input-${factUid}`}
          value={currentContentClaim}
          onChange={(e) => onEdit({ editedContentClaim: e.target.value })}
          placeholder="화자가 실제로 말한 내용"
          rows={3}
          className={
            'w-full rounded-md border border-border-subtle bg-bg-elevated '
            + 'p-2 text-sm text-text-primary focus:outline-none '
            + 'focus:border-accent-cool resize-y'
          }
        />
      </div>
      <div>
        <label
          className="text-xxs text-text-muted font-mono opacity-60 block mb-1"
          htmlFor={`fact-form-modality-${factUid}`}
        >
          modality (양태)
        </label>
        <select
          id={`fact-form-modality-${factUid}`}
          data-testid={`fact-form-modality-select-${factUid}`}
          // ★ REQ-014-D (PO 2026-07-02) — modality select 초기값 복원.
          //   옛: currentSpeechAct.toLowerCase() 를 옵션 value 와 exact 비교
          //   → 한국어 술어 ("말했다") 는 하나도 매칭 못 함 → 항상 "양태 미지정".
          //   fix: classifyClaimModality 로 (영문/한국어) 어느 쪽이든 canonical
          //   modality 로 매핑 후 select value 로 세팅. 매핑 실패한 완전
          //   자유 텍스트만 미지정으로 남는다.
          value={classifyClaimModality(currentSpeechAct) ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val) onEdit({ editedSpeechAct: val });
          }}
          className={
            'w-full rounded-md border border-border-subtle bg-bg-elevated '
            + 'p-2 text-sm text-text-primary focus:outline-none '
            + 'focus:border-accent-cool'
          }
        >
          <option value="">(speech_act 자유 텍스트 유지 — 양태 미지정)</option>
          {MODALITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="text-xxs text-text-muted opacity-60 mt-1">
          모달리티를 명시하면 speech_act 를 표준 토큰(assertion/judgment/opinion)
          으로 저장합니다. 자유 텍스트 (예: "발표했다") 는 위 입력으로 그대로 유지.
        </p>
      </div>
      <p className="text-xxs text-text-muted font-mono opacity-70">
        preview:{' '}
        <span data-testid={`fact-claim-preview-${factUid}`}>
          {`${speakerLabel || '?'} [${currentSpeechAct || '?'}]: "${currentContentClaim || '?'}"`}
        </span>
      </p>
    </div>
  );
}
