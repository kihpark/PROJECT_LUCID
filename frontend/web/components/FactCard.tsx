'use client';

import { useMemo, useState, useEffect } from 'react';
import { ActionButton } from './ActionButton';
import { GraphNoteEditor } from './GraphNoteEditor';
import {
  ClaimModalityBadge,
  classifyClaimModality,
  MODALITY_LABEL,
} from './ClaimModalityBadge';
import type { FactAction, FactSummary, ObjectSummary } from '@/lib/types';
import type { Lang } from './LangToggle';
import {
  ActionFactForm,
  MeasurementFactForm,
  ClaimFactForm,
  type FactFormEdits,
} from './FactTypeForms';

// ---------------------------------------------------------------------------
// fact-display-unification — shared fact_type-aware sub-components.
//
// PO escalation (2026-06-24): Decide and Recall used to render fact cards
// via TWO completely separate components — Decide's FactCard branched on
// fact_type to show CLAIM/MEASUREMENT badges + strips, while Recall's
// RecallFactCard had ZERO branching, so the SAME fact looked totally
// different across the two surfaces. This pair of presentational
// sub-components is the single source of truth for the fact_type display
// surface: badge + strip, no other coupling. Both FactCard (Decide) and
// RecallFactCard (Recall) consume them so the visual is identical.
//
// Contract: each component early-returns null when fact_type is not
// 'claim' or 'measurement' (matching the existing legacy-safe guards).
// Props are structurally typed so any consumer with the matching field
// names (FactSummary, RecallFact, FactDetailHeader) wires for free.
// ---------------------------------------------------------------------------

export interface FactTypeFields {
  fact_type?: 'action' | 'claim' | 'measurement' | null;
  speaker_label?: string | null;
  speech_act?: string | null;
  content_claim?: string | null;
  metric?: string | null;
  measurement_value?: number | null;
  measurement_unit?: string | null;
  as_of?: string | null;
}

export function FactTypeBadge({
  factType, factUid, speechAct,
}: { factType: FactTypeFields['fact_type']; factUid: string; speechAct?: string | null }) {
  if (factType === 'claim') {
    // ★ REQ-004 결함 2 (PO 2026-06-30) — claim modality 표시 전 화면 일관.
    // 옛: CLAIM 배지만 → 단정/판단/의견 구분 없음 (사용자가 양태를 알 길 0).
    // fix: CLAIM 배지 옆에 modality 배지를 동반 출력. 분류 안 되면 modality
    // 배지 자체가 null 을 반환하므로 옛 동작과 회귀 0.
    const modality = classifyClaimModality(speechAct);
    return (
      <span className="inline-flex items-center gap-1">
        <span
          data-testid={`fact-claim-badge-${factUid}`}
          className="inline-flex items-center text-xxs font-mono text-accent-cool bg-accent-cool/10 border border-accent-cool/30 rounded px-1.5 py-0.5"
          title="화자 인용 (one-hop provenance — 내용 진실은 보증되지 않음)"
        >
          CLAIM
        </span>
        <ClaimModalityBadge modality={modality} factUid={factUid} />
      </span>
    );
  }
  if (factType === 'measurement') {
    return (
      <span
        data-testid={`fact-measurement-badge-${factUid}`}
        className="inline-flex items-center text-xxs font-mono text-accent-warm bg-accent-warm/10 border border-accent-warm/30 rounded px-1.5 py-0.5"
        title="수치 측정 (numeric data pinned to a timepoint — 시계열의 한 점)"
      >
        MEASUREMENT
      </span>
    );
  }
  // ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 5) — ACTION 배지 추가.
  // 옛: action / 옛 legacy null → null 반환 (배지 없음). claim 노드는
  // CLAIM, measurement 노드는 MEASUREMENT 배지로 표시되는데 action 만
  // 빠져 fact_type 식별 일관성이 깨졌다. fix: action 도 ACTION 배지.
  // legacy (null) 도 action 으로 fallback 하는 것과 일관되게 ACTION 으로.
  //
  // ★ REQ-014-B B3 (PO 2026-07-02) — ACTION 태그 초록.
  //   옛: 회색 (text-text-secondary + bg-bg-elevated) — CLAIM (accent-cool
  //   teal), MEASUREMENT (accent-warm amber) 와 색 대비가 약해 3종 fact_type
  //   식별이 흐릿했다. fix: emerald (#10B981) 로 통일. 회색 팔레트 폐기.
  //   Tailwind 표준 emerald-400/500 스케일을 그대로 사용 — 프로젝트 팔레트
  //   에 별도 accent-success 가 있지만 e2e 가 색 코드로 검증할 수 있게 명시
  //   verbatim 값을 유지. data-fact-badge-color attr 은 e2e 스냅샷용.
  if (factType === 'action' || factType == null) {
    return (
      <span
        data-testid={`fact-action-badge-${factUid}`}
        data-fact-badge-color="#10B981"
        className="inline-flex items-center text-xxs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/40 rounded px-1.5 py-0.5"
        title="행위 (subject가 object에 한 일)"
      >
        ACTION
      </span>
    );
  }
  return null;
}

export function FactTypeStrip({
  fact, factUid, lang,
}: { fact: FactTypeFields; factUid: string; lang: Lang }) {
  // PO claim-display-format (recovery spec PR B): bold speaker WITHOUT
  // brackets, brackets around speech_act, quotes around content_claim.
  // Visual: **국가데이터처**[발표했다]: "4월 기준 증가율은…"
  //
  // ★ REQ-004 결함 2 (PO 2026-06-30) — modality 표시 전 화면 일관.
  // speech_act 가 modality 키워드 (assertion / judgment / opinion 동의어)
  // 면 raw 영문 token 대신 한국어 양태 라벨 (단정 / 판단 / 의견) 을 strip
  // 의 brackets 안에 노출한다. 분류 안 되는 verb (예: "발표했다") 는
  // 옛 동작 verbatim (raw text). data-modality attr 은 e2e 가 strip 의
  // 양태도 카드 외에서 직접 검증할 수 있게 한다.
  if (fact.fact_type === 'claim') {
    if (!fact.speaker_label && !fact.speech_act && !fact.content_claim) {
      return null;
    }
    const modality = classifyClaimModality(fact.speech_act);
    const speechActLabel = modality ? MODALITY_LABEL[modality] : fact.speech_act;
    return (
      <p
        data-testid={`fact-claim-strip-${factUid}`}
        data-modality={modality ?? ''}
        className="text-sm text-text-secondary mb-3 pl-7 italic"
        lang={lang === 'kr' ? 'ko' : 'en'}
      >
        {fact.speaker_label && (
          <strong className="font-bold not-italic">{fact.speaker_label}</strong>
        )}
        {speechActLabel && (
          <span
            data-testid={`fact-claim-strip-speech-act-${factUid}`}
            className="ml-1 not-italic"
          >
            [{speechActLabel}]:
          </span>
        )}
        {fact.content_claim && (
          <span className="ml-1">&ldquo;{fact.content_claim}&rdquo;</span>
        )}
      </p>
    );
  }
  if (fact.fact_type === 'measurement') {
    const hasValue = fact.measurement_value !== null && fact.measurement_value !== undefined;
    if (!fact.metric && !hasValue && !fact.measurement_unit && !fact.as_of) {
      return null;
    }
    return (
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
        {hasValue && (
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
    );
  }
  return null;
}

interface EditPayload {
  action: FactAction;
  editedClaim?: string;
  editedSubjectUid?: string;
  editedSubjectLabel?: string;
  editedPredicate?: string;
  editedObjectValue?: string;
  editedObjectLabel?: string;
  // ★ REQ-014-B B1 — fact_type 별 폼의 편집 payload.
  editedMetric?: string;
  editedMeasurementValue?: number | null;
  editedMeasurementUnit?: string;
  editedAsOf?: string;
  editedSpeakerUid?: string;
  editedSpeakerLabel?: string;
  editedSpeechAct?: string;
  editedContentClaim?: string;
}

interface Props {
  fact: FactSummary;
  lang: Lang;
  objects?: ObjectSummary[];
  action: FactAction;
  editedClaim?: string;
  editedSubjectUid?: string;
  editedSubjectLabel?: string;
  editedPredicate?: string;
  editedObjectValue?: string;
  editedObjectLabel?: string;
  editedMetric?: string;
  editedMeasurementValue?: number | null;
  editedMeasurementUnit?: string;
  editedAsOf?: string;
  editedSpeakerUid?: string;
  editedSpeakerLabel?: string;
  editedSpeechAct?: string;
  editedContentClaim?: string;
  onChange: (next: EditPayload) => void;
  reviewMode?: boolean;
  spaceId?: string;
}

function displayClaim(fact: FactSummary, lang: Lang): string {
  // decide-claim-format-apply (2026-06-24): for claim facts, always
  // surface the ORIGINAL fact.claim sentence, NEVER fact.claim_en,
  // regardless of UI lang. PO dogfood evidence: the LLM populates
  // claim_en for claim facts with a synthesized template that
  // matches the OLD rejected layout — [speaker_label]"speech_act":content_claim
  // (bracketed speaker, quoted speech_act, plain content) — so Decide
  // (which forces lang=en) was rendering that template as the card
  // title, even though FactTypeStrip below shows the correct PO spec.
  // Recall renders fact.claim (original natural sentence) directly and
  // was therefore unaffected; this branch makes Decide consume the same
  // surface so the title is the natural sentence everywhere and the
  // PO-spec strip is the single source of structure.
  if (fact.fact_type === 'claim') {
    return fact.claim;
  }
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
    // ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 1, 2) — UUID 화면 노출 0.
    // 옛: `${value} (미해석)` — UUID 가 Decide 카드 / Recall edit input 에
    // 노출됐다. v3 entity-id-only 저장 구조에선 ★ 모든 entity 가 UUID
    // 모양. fix: 못 끌어오면 "미해결 entity" 배지 only (★ UUID X).
    return lang === 'en' ? 'unresolved entity' : '미해결 entity';
  }
  return value;
}

function regenerateClaim(subjectLabel: string, predicate: string, objectLabel: string): string {
  const s = subjectLabel || '?';
  const p = predicate || '?';
  const o = objectLabel || '?';
  return `${s} | ${p} | ${o}`;
}

// ★ REQ-014-B — useDebounce 는 FactTypeForms 안 EntityField 로 이동. FactCard
//   자체는 fact_type 별 폼에게 편집 UI 를 위임하므로 debounced 검색은 폼
//   내부 책임이 됐다.

export function FactCard({
  fact,
  lang,
  objects,
  action,
  editedClaim,
  editedSubjectUid,
  editedSubjectLabel,
  editedPredicate,
  editedObjectValue,
  editedObjectLabel,
  editedMetric,
  editedMeasurementValue,
  editedMeasurementUnit,
  editedAsOf,
  editedSpeakerUid,
  editedSpeakerLabel,
  editedSpeechAct,
  editedContentClaim,
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

  // ★ REQ-014-B — SPO 3칼럼 획일 폼 폐기 이후 dead code (subjectQuery /
  //   objectQuery / predicateQuery / suggestion fetch effects / chip-click
  //   handlers) 는 fact_type 별 폼 (FactTypeForms.tsx 안 EntityField 가
  //   자체 소유) 으로 위임됐다. 여기 남은 useMemo previewClaim 은 미편집
  //   요약 view 에서만 참고되며 (dl grid), edit path 는 form 이 자기 preview
  //   를 그린다.

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

  // ★ REQ-014-B B1 — fact_type 별 폼이 부분 patch 를 emit 한다. parent 는
  //   기존 editedClaim / editedSubjectUid / editedPredicate / editedObjectValue
  //   을 유지하면서 새 fact_type 필드 (metric / value / unit / as_of /
  //   speaker_uid / speech_act / content_claim) 를 함께 실어 보낸다. 이
  //   payload 는 DecideOverlay 가 edited_metadata dict 로 감싸 backend
  //   _coerce_fact_to_factnode 의 meta.update() 지점에서 fact_summary 위에
  //   덮인다 — backend 는 이미 measurement_* / speaker_* / content_claim 등
  //   전체 v0.2 필드를 canonical_kwargs 로 흘리므로 별도 endpoint 확장 없이
  //   저장 라운드트립이 완결된다 (see backend/api/routes/validate.py
  //   _coerce_fact_to_factnode L469~478 verbatim).
  //
  // ★ B4 subject 수정 반영: `editedSubjectLabel` 을 patch 에 실어
  //   edited_metadata.subject_label 로도 보낸다. 이는 lucid_facts 문서의
  //   surface subject_label 을 갱신하는 두 번째 경로이고, entity 대표명
  //   자체는 여전히 EntityNameEdit path 로만 rename 가능하다는 사실을
  //   FactTypeForms 안 EntityNameNoticeLink 가 사용자에게 안내한다.
  const emitFactTypePatch = (patch: FactFormEdits) => {
    // Recompute claim only when the ACTION triple is what changed —
    // MEASUREMENT / CLAIM 은 자기 필드의 preview 로 대신 표시된다.
    let nextClaim = editedClaim;
    if (fact.fact_type !== 'measurement' && fact.fact_type !== 'claim') {
      const nextSubject = patch.editedSubjectUid ?? currentSubject;
      const nextPredicate = patch.editedPredicate ?? currentPredicate;
      const nextObject = patch.editedObjectValue ?? currentObject;
      const nextSubjectLabel = resolveEntity(nextSubject, labelMap, lang);
      const nextObjectLabel = resolveEntity(nextObject, labelMap, lang);
      nextClaim = regenerateClaim(nextSubjectLabel, nextPredicate, nextObjectLabel);
    }
    onChange({
      action: 'edit',
      editedClaim: nextClaim,
      editedSubjectUid: patch.editedSubjectUid ?? editedSubjectUid,
      editedSubjectLabel: patch.editedSubjectLabel ?? editedSubjectLabel,
      editedPredicate: patch.editedPredicate ?? editedPredicate,
      editedObjectValue: patch.editedObjectValue ?? editedObjectValue,
      editedObjectLabel: patch.editedObjectLabel ?? editedObjectLabel,
      editedMetric: patch.editedMetric ?? editedMetric,
      editedMeasurementValue:
        patch.editedMeasurementValue !== undefined
          ? patch.editedMeasurementValue
          : editedMeasurementValue,
      editedMeasurementUnit: patch.editedMeasurementUnit ?? editedMeasurementUnit,
      editedAsOf: patch.editedAsOf ?? editedAsOf,
      editedSpeakerUid: patch.editedSpeakerUid ?? editedSpeakerUid,
      editedSpeakerLabel: patch.editedSpeakerLabel ?? editedSpeakerLabel,
      editedSpeechAct: patch.editedSpeechAct ?? editedSpeechAct,
      editedContentClaim: patch.editedContentClaim ?? editedContentClaim,
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
    // editedPredicate / editedObjectValue (플러스 REQ-014-B 의 fact_type
    // 별 필드) for the batch submit. Just close the local form.
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.debug('[FactCard] 4. save payload', {
        factType: fact.fact_type,
        editedSubjectUid,
        editedSubjectLabel,
        editedPredicate,
        editedObjectValue,
      });
    }
    setEditFormOpen(false);
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
            {/* fact-display-unification: badge rendering is delegated to
                the shared FactTypeBadge sub-component (declared at the
                top of this module) so Decide and Recall render the
                fact_type signal identically. The component itself
                early-returns null for action / legacy / undefined
                fact_type — matches the previous Decide guard verbatim. */}
            <FactTypeBadge
              factType={fact.fact_type}
              factUid={factUid}
              speechAct={fact.speech_act}
            />
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

      {/* fact-display-unification: both the claim strip
          (speaker / speech_act / content_claim) and the measurement
          strip (metric / value / unit / as_of) are now delegated to the
          shared FactTypeStrip sub-component at the top of this module.
          The component itself owns the legacy-safe early returns:
          - fact_type !== 'claim'/'measurement' → null
          - empty fields → null
          So Decide's behaviour is identical to before, and Recall picks
          up the same renderer to fix the (a)/(c)/(d) divergence the PO
          escalated.

          PO claim-display-format spec (recovery spec PR B):
          **국가데이터처**[발표했다]: "4월 기준 증가율은…" — bold speaker
          without brackets, brackets around speech_act, quotes around
          content_claim. The shared component encodes this directly. */}
      {!isEditing && (
        <FactTypeStrip fact={fact} factUid={factUid} lang={lang} />
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

      {/* ★ REQ-014-B B1 (PO 2026-07-02) — fact_type 별 편집 폼.
       *
       *  옛: 모든 atomic fact 를 SPO 3칼럼 획일 분해 (subject / predicate /
       *  object 입력 3 개) — ACTION 은 자연스럽지만 CLAIM (speaker / speech_act /
       *  content_claim / modality) 와 MEASUREMENT (subject + metric + value +
       *  unit + as_of) 는 3칼럼에 맞지 않아 사용자 편집 UX 가 붕괴됐다.
       *  fix: fact_type 별로 편집 컴포넌트 분리.
       *   - ACTION       → <ActionFactForm />
       *   - MEASUREMENT  → <MeasurementFactForm />
       *   - CLAIM        → <ClaimFactForm />
       *  옛 3칼럼 SPO grid 폐기. legacy null (fact_type 미주석) 은 ACTION
       *  분기 fallback — 옛 FactTypeBadge 규칙과 동일. */}
      {isEditing && fact.fact_type === 'measurement' && (
        <>
          <MeasurementFactForm
            fact={fact}
            factUid={factUid}
            lang={lang}
            spaceId={spaceId}
            objects={objects}
            edits={{
              editedSubjectUid,
              editedSubjectLabel,
              editedMetric,
              editedMeasurementValue,
              editedMeasurementUnit,
              editedAsOf,
            }}
            onEdit={(patch) => emitFactTypePatch(patch)}
          />
        </>
      )}
      {isEditing && fact.fact_type === 'claim' && (
        <>
          <ClaimFactForm
            fact={fact}
            factUid={factUid}
            lang={lang}
            spaceId={spaceId}
            objects={objects}
            edits={{
              editedSpeakerUid,
              editedSpeakerLabel,
              editedSpeechAct,
              editedContentClaim,
              editedSubjectUid,
            }}
            onEdit={(patch) => emitFactTypePatch(patch)}
          />
        </>
      )}
      {isEditing
        && fact.fact_type !== 'measurement'
        && fact.fact_type !== 'claim'
        && (
        <>
          <ActionFactForm
            fact={fact}
            factUid={factUid}
            lang={lang}
            spaceId={spaceId}
            objects={objects}
            edits={{
              editedSubjectUid,
              editedSubjectLabel,
              editedPredicate,
              editedObjectValue,
              editedObjectLabel,
            }}
            onEdit={(patch) => emitFactTypePatch(patch)}
          />
        </>
      )}

      {isEditing && (
        <p className="text-xxs text-text-muted pl-7 mb-3 opacity-60">
          Original claim preserved as alias on the persisted FactNode (DR-036).
        </p>
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