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
  isUuidLike,
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
 *
 *  ★ REQ-014-E (PO 2026-07-02) — 이슈 1: `validator_id` 도 STAGE 3+4 대상.
 *    backend `_hit_to_fact` 은 user_id (UUID) 를 그대로 흘려보내며,
 *    이전 구현은 `by = rf.validator_id ?? ''` 그대로 meta 라인에 노출 →
 *    "미해결 출처" 옆에 UUID 노출 회귀. resolve 실패 (UUID 형식) 면
 *    빈 문자열 리턴 → 소비 측에서 아예 렌더 skip. 사람 이름 (예: "박기흥",
 *    "PO") 은 그대로 표시.
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

  // ★ REQ-014-E — validator_id 가 UUID 형식이면 사용자 노출 0.
  //   실 backend 는 user_id (UUID) 를 흘려보내며, 사람이 읽지 못한다.
  //   test 시드 ("박기흥", "PO") 처럼 사람 이름은 그대로 표시.
  const validatorRaw = rf.validator_id?.trim() ?? '';
  const by = validatorRaw && !isUuidLike(validatorRaw) ? validatorRaw : '';

  return {
    subject: resolveEntityLabel(rf.subject_label),
    predicate: rf.predicate_label && rf.predicate_label.trim()
      ? rf.predicate_label
      : rf.predicate,
    object,
    src,
    srcResolved: firstUrlIdx >= 0,
    date: rf.validated_at?.slice(0, 10) ?? '',
    by,
  };
}

/**
 * ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01) —
 * ★ REQ-014-E (PO 2026-07-02) — 이슈 2: "유사 참고" (amber) 배지 완전 폐기.
 *
 *  옛 로직: match_kind !== 'entity_direct' → "유사 참고" amber 배지.
 *  PO 판단 verbatim: "클릭도 안 되는데 왜? 사용자 무가치."
 *  배지가 사용자에게 action 을 유도하지 않으므로 = 노이즈.
 *
 *  근거 카드 자체에 오르는 사실은 이미 recall API 가 relevance 필터를
 *  통과시킨 결과 — "직접" vs "유사" 는 백엔드 내부 사정. 사용자는 사실을
 *  "믿을 수 있는가" 만 궁금하며, 이는 출처·검증일 라인에서 판단한다.
 *
 *  ★ 렌더 skip. 데이터 자체 (match_kind) 는 유지 (백엔드/테스트/후속 UI
 *    재활용 여지) — 다만 이 카드는 표시하지 않는다.
 *  ★ testid `recall-evidence-match-kind` 참조하는 옛 e2e 는 이 fix 커밋
 *    에서 함께 없애거나 skip 하도록 정리 (관련 spec 별도).
 */
type MatchKind =
  | 'embedding'
  | 'entity_link'
  | 'entity_direct'
  | 'similarity_fallback'
  | null
  | undefined;

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

  // ★ REQ-014-E — match_kind 는 데이터는 유지, 렌더 skip. 옛 참조 흔적.
  //   (백엔드 필드 자체는 hallucination 가드 후속 UI 에 재활용.)
  const _matchKind: MatchKind = isReal ? props.realFact!.match_kind : undefined;
  void _matchKind;

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

  // ★ REQ-014-E (PO 2026-07-02) — 이슈 3: 카드 wrapper 자체는 clickable X.
  //   옛 구현은 cursor: pointer + hover 시 border 강조 → PO dogfood: "클릭
  //   해도 아무 동작 X. 왜?". 커서를 default 로 되돌리고 hover 강조도 제거.
  //   subject (대상) 클릭 = 유지 (↓ handleSubjectClick).
  return (
    <div
      data-testid="recall-evidence-card"
      data-recall-evidence-mode={isReal ? 'real' : 'example'}
      style={{
        background: '#0b1114',
        border: '1px solid #14211f',
        borderRadius: 12,
        padding: '13px 15px',
        cursor: 'default',
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
        {/* ★ REQ-014-E — 옛 match_kind 배지 폐기 (사용자 무가치 노이즈). */}
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
        {/* ★ REQ-014-E — validator_id 가 UUID 면 by = '' → separator + span skip. */}
        {display.by ? (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{display.by}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
