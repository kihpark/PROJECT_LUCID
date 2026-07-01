'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — 근거 사실 카드 (S-P-O).
 *
 * 의뢰서 §4-4-(좌) verbatim:
 *   "각 카드 = 주어(대상)·서술어(관계 pill, teal outline)·목적어 한 줄 +
 *    메타(출처 · 검증일 · 검증자). 대상(주어)은 클릭 가능한 모양
 *    (teal 점선 밑줄, hover 강조) — 클릭 시 entity 상세뷰 진입 동선
 *    (상세뷰 자체는 REQ-004 후). 여러 entity 를 열어 비교."
 *
 * v1: 클릭 = 자리만 (★ entity 상세뷰 미구현).
 *
 * ★ REQ-011-v2 (★ PO 2026-07-01) — 실 path 연결.
 *   두 가지 props 모드 지원:
 *     (a) fact: RecallExampleFact — v1 EXAMPLE_RECENT_RECALL 호환 (★ 보존).
 *     (b) realFact: RecallFact      — recall API 응답 (★ v2 신규).
 *   onSubjectClick 도 모드별로 시그너처가 다르다:
 *     (a) (subject_label: string)            — v1 (entity 상세뷰 진입 자리).
 *     (b) (subject_uid, subject_label)       — v2 (★ REQ-012 entity 수정 모달 진입).
 *
 *   동일 시각 디자인 (의뢰서 §4-4-(좌)) 을 유지하면서, render 함수 안에서만
 *   분기. 옛 호출부 (v1 EXAMPLE 경로) 는 한 글자도 깨지지 않는다.
 */

import type { RecallExampleFact } from '@/lib/recall-history';
import type { RecallFact } from '@/lib/types';
import {
  resolveEntityLabel,
  resolveSourceLabel,
  UNRESOLVED_SOURCE_LABEL,
} from '@/lib/displayNames';

interface ExampleProps {
  fact: RecallExampleFact;
  realFact?: undefined;
  onSubjectClick?: (subject: string) => void;
}

interface RealProps {
  fact?: undefined;
  realFact: RecallFact;
  onSubjectClick?: (subjectUid: string, subjectLabel: string) => void;
}

type Props = ExampleProps | RealProps;

/** ★ REQ-011-v2 dogfood-3 fix (PO 2026-07-01) —
 *  recall API → 카드 표시 라벨로의 안전 매핑.
 *
 *  dogfood 3 이슈 2 재확인 verbatim:
 *    "UID 화면 노출 = REQ-004 STAGE 3+4 원칙 전체 적용.
 *     UUID → canonical_name 조회. 못 찾으면 '미해결 entity' placeholder."
 *
 *  기존 구현이 subject_label 이 있으면 그대로 사용했으나, backend 가
 *  드물게 UUID 를 subject_label 위치로 흘려보내는 회귀 케이스가 있어
 *  resolveEntityLabel 이 label 자체가 UUID 형식인지도 검사한다.
 *
 *  object_value 를 fallback 으로 쓰던 옛 로직도 폐기 — object 가 entity
 *  이면 object_uid 가 있고, object_value 는 UUID 사본. object 가 literal
 *  이면 object_uid 는 null 이며 object_value 가 사람이 읽는 값이므로
 *  literal 만 fallback 대상.
 *
 *  source_uid 는 URL 이면 host+path 표시, 그 외 (UUID) 는 "미해결 출처".
 *  ★ 다중 source 는 첫 non-placeholder 를 우선. 모두 UUID → "미해결 출처".
 */
function deriveRealDisplay(rf: RecallFact): {
  subject: string;
  predicate: string;
  object: string;
  src: string;
  srcResolved: boolean;
  date: string;
  by: string;
} {
  const objectIsEntity = !!(rf.object_uid && rf.object_uid.trim());
  const objectRaw = objectIsEntity ? rf.object_label : (rf.object_label ?? rf.object_value);
  const object = objectIsEntity
    ? resolveEntityLabel(rf.object_label)
    : (objectRaw?.trim() || resolveEntityLabel(null));

  // source: URL 이 있는 첫 번째를 우선. 없으면 "미해결 출처".
  const resolvedList = (rf.source_uids ?? []).map(resolveSourceLabel);
  const firstUrlIdx = resolvedList.findIndex(
    (s) => s !== UNRESOLVED_SOURCE_LABEL,
  );
  const src = firstUrlIdx >= 0 ? resolvedList[firstUrlIdx]! : UNRESOLVED_SOURCE_LABEL;

  return {
    subject: resolveEntityLabel(rf.subject_label),
    predicate: rf.predicate_label && rf.predicate_label.trim()
      ? rf.predicate_label
      : rf.predicate,
    object,
    src,
    srcResolved: firstUrlIdx >= 0,
    date: rf.validated_at?.slice(0, 10) ?? '',
    by: rf.validator_id ?? '',
  };
}

/**
 * ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01) —
 * `match_kind` badge. Renders 직접 언급 (teal) when the fact was returned
 * because the query *strictly* referenced this fact's entity, or 유사 참고
 * (amber) when the fact reached the response via embedding similarity or
 * cross-entity graph expansion. Anything non-`entity_direct` reads as
 * 유사 참고 so the user always sees WHICH kind of match they're looking
 * at. This is the visible half of the hallucination guard: users can
 * tell at a glance whether HEARTH's answer is grounded in a direct
 * mention or in a similarity neighbour.
 */
type MatchKind =
  | 'embedding'
  | 'entity_link'
  | 'entity_direct'
  | 'similarity_fallback'
  | null
  | undefined;

function renderMatchKindBadge(kind: MatchKind) {
  const isDirect = kind === 'entity_direct';
  const label = isDirect ? '직접 언급' : '유사 참고';
  const testKind = isDirect ? 'entity_direct' : 'similarity_fallback';
  // Teal (직접 언급) — reuse the same teal token the subject / predicate
  // pill already use (see #2DD4BF / rgba(45,212,191,*) below). Amber
  // (유사 참고) — Tailwind amber-300/400 range (#FCD34D / #F59E0B),
  // consistent with the moderation warning badges elsewhere in the FE.
  const color = isDirect ? '#5fe6d3' : '#FBBF24';
  const border = isDirect
    ? 'rgba(45,212,191,0.35)'
    : 'rgba(251,191,36,0.35)';
  return (
    <span
      data-testid="recall-evidence-match-kind"
      data-recall-match-kind={testKind}
      className="font-mono"
      style={{
        fontSize: 10,
        color,
        border: `1px solid ${border}`,
        borderRadius: 5,
        padding: '1px 6px',
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </span>
  );
}

export function RecallEvidenceCard(props: Props) {
  const isReal = 'realFact' in props && props.realFact !== undefined;

  const display = isReal
    ? deriveRealDisplay(props.realFact!)
    : {
        subject: props.fact!.s,
        predicate: props.fact!.p,
        object: props.fact!.o,
        src: props.fact!.src,
        srcResolved: true, // v1 예시 = 이미 사람이 읽는 값 (Bloomberg / WSJ …).
        date: props.fact!.date,
        by: props.fact!.by,
      };

  // Only real facts carry a match_kind (v1 example mode has no such
  // concept). Undefined here is treated as "유사 참고" in the badge
  // renderer — safest default when the backend response predates the
  // field.
  const matchKind: MatchKind = isReal ? props.realFact!.match_kind : undefined;

  const handleSubjectClick = () => {
    if (isReal) {
      const rf = props.realFact!;
      if (rf.subject_uid) {
        (props.onSubjectClick as
          | ((uid: string, label: string) => void)
          | undefined)?.(rf.subject_uid, display.subject);
      }
    } else {
      (props.onSubjectClick as ((s: string) => void) | undefined)?.(
        props.fact!.s,
      );
    }
  };

  return (
    <div
      data-testid="recall-evidence-card"
      data-recall-evidence-mode={isReal ? 'real' : 'example'}
      style={{
        background: '#0b1114',
        border: '1px solid #14211f',
        borderRadius: 12,
        padding: '13px 15px',
        cursor: 'pointer',
        transition: 'border-color 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#21342f';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#14211f';
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {/* 주어 (대상) — 클릭 가능. */}
        <button
          type="button"
          data-testid="recall-evidence-subject"
          onClick={handleSubjectClick}
          style={{
            color: '#9af0e0',
            fontWeight: 600,
            borderBottom: '1px dashed rgba(45,212,191,0.4)',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            borderBottomWidth: 1,
            borderBottomStyle: 'dashed',
            borderBottomColor: 'rgba(45,212,191,0.4)',
            padding: 0,
            fontSize: 14,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderBottomColor = '#2DD4BF';
            e.currentTarget.style.color = '#bff5ea';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderBottomColor = 'rgba(45,212,191,0.4)';
            e.currentTarget.style.color = '#9af0e0';
          }}
        >
          {display.subject}
        </button>
        {/* 서술어 (관계 pill). */}
        <span
          className="font-mono"
          data-testid="recall-evidence-predicate"
          style={{
            fontSize: 10.5,
            color: '#5fe6d3',
            border: '1px solid rgba(45,212,191,0.3)',
            borderRadius: 5,
            padding: '1px 7px',
          }}
        >
          {display.predicate}
        </span>
        {/* 목적어. */}
        <span
          data-testid="recall-evidence-object"
          style={{ color: '#cbd6d8' }}
        >
          {display.object}
        </span>
        {/* ★ match_kind 배지 (real 모드 전용). */}
        {isReal && renderMatchKindBadge(matchKind)}
      </div>
      {/* 메타 한 줄. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          marginTop: 9,
          fontSize: 11,
          color: '#566569',
        }}
      >
        <span
          data-testid="recall-evidence-source"
          data-recall-source-resolved={display.srcResolved ? 'true' : 'false'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: display.srcResolved ? '#7d9b95' : '#7a6a58',
            fontStyle: display.srcResolved ? 'normal' : 'italic',
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: display.srcResolved ? '#2f6f64' : '#5a4a3a',
            }}
          />
          {display.src}
        </span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>검증 {display.date}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{display.by}</span>
      </div>
    </div>
  );
}
