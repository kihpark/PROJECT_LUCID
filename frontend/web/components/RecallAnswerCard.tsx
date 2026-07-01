'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — 답변 카드.
 *
 * 의뢰서 §4-3 verbatim:
 *   "ANSWER 배지 + 근거 충분 [예시] + 4 칸 충분도 바 (3/4 채움).
 *    답변 본문 (17px, 합성된 자연어 문장). 핵심 칩 행.
 *    하단 구분선 + 정직성 한 줄 '이 답은 당신이 검증한 N개의 사실에만
 *    근거합니다. 그 밖은 모릅니다.'"
 *
 * v1 = 답변 본문 = 예시 (recall-history). v2 = HEARTH endpoint
 * (postAssistantBrief) 합성 결과. PO 결정 3 (★ Q&A engine = HEARTH 동일).
 *
 * ★ REQ-011-v2 (★ PO 2026-07-01) — 실 path 연결.
 *   - answerText / confFacts 는 그대로 (호환 보존).
 *   - chips 는 optional (v2 = recall API 가 chip 후보를 따로 주지 않음).
 *   - isExample default 는 props 가 안 줄 때만 true 로 fallback 가능하도록
 *     호출부에서 명시 전달.
 *   - 시각 디자인 변경 0.
 *
 * ★ REQ-011-v2 dogfood-3 fix (PO 2026-07-01) — 근거 충분도 4 단계 명세.
 *   옛 v1/v2 는 항상 3/4 채움 (하드코딩). PO dogfood 3 재확인 verbatim:
 *     "기준 정의(fact수? 출처다양성?) 명시하거나 제거. 정의 없는 지표 금지."
 *
 *   결정: fact 수 기준 4 단계 명시.
 *     · 1건 → 1/4 "부족"    (신뢰 낮음 — 단일 사실만)
 *     · 2-4건 → 2/4 "낮음"    (교차 검증 부족)
 *     · 5-10건 → 3/4 "충분"    (교차 검증 확보)
 *     · 11건+ → 4/4 "풍부"    (강한 근거)
 *
 *   출처 다양성 (uniqueSources) 은 별도 지표 — 카드 상단 trust-meta 에 이미
 *   "출처 N곳" 으로 노출. 이 4 단계 바는 fact 밀도만 반영. Rationale = 사용자
 *   질문에 대한 검증 사실 밀도가 카드의 "충분도" 의 1차 신호이며, 출처 다양
 *   성은 별도 축이므로 하나의 바에 섞으면 명확성이 떨어진다.
 *
 *   tooltip = <div title=""> 로 각 단계 기준을 hover 노출 (★ PO "정의 명시").
 */

const SUFFICIENCY_TOOLTIP =
  '근거 충분도 (검증 사실 수 기준):\n'
  + '  · 1건 = 부족 (단일 사실)\n'
  + '  · 2-4건 = 낮음 (교차 검증 부족)\n'
  + '  · 5-10건 = 충분 (교차 검증 확보)\n'
  + '  · 11건+ = 풍부 (강한 근거)\n'
  + '\n출처 다양성은 상단 "출처 N곳" 지표를 참고.';

interface SufficiencyLevel {
  filled: number;
  label: string;
  key: 'insufficient' | 'low' | 'sufficient' | 'abundant';
}

/** ★ REQ-011-v2 dogfood-3 fix — fact 수 → 충분도 (1..4) + 한국어 label. */
export function sufficiencyLevelForFacts(facts: number): SufficiencyLevel {
  if (facts <= 1) return { filled: 1, label: '부족', key: 'insufficient' };
  if (facts <= 4) return { filled: 2, label: '낮음', key: 'low' };
  if (facts <= 10) return { filled: 3, label: '충분', key: 'sufficient' };
  return { filled: 4, label: '풍부', key: 'abundant' };
}

interface Props {
  answerText: string;
  /** v1 = 시안의 핵심 칩 행. v2 = optional (★ recall API 에는 없음). */
  chips?: string[];
  confFacts: number;
  /** "예시" 또는 "후속" 마커 표시 여부 (v1 = true / v2 실데이터 = false). */
  isExample?: boolean;
}

export function RecallAnswerCard({
  answerText,
  chips = [],
  confFacts,
  isExample = true,
}: Props) {
  const sufficiency = sufficiencyLevelForFacts(confFacts);
  return (
    <div
      data-testid="recall-answer-card"
      data-recall-answer-example={isExample ? 'true' : 'false'}
      data-recall-sufficiency-level={sufficiency.key}
      data-recall-sufficiency-filled={sufficiency.filled}
      style={{
        background: 'linear-gradient(180deg,#0c1417,#0a1013)',
        border: '1px solid #173028',
        borderRadius: 16,
        padding: '24px 26px',
        marginBottom: 18,
        boxShadow: '0 0 40px rgba(45,212,191,0.04)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          marginBottom: 15,
        }}
      >
        <span
          className="font-mono"
          data-testid="recall-answer-badge"
          style={{
            fontSize: 10,
            letterSpacing: '0.16em',
            color: '#5fe6d3',
            background: 'rgba(45,212,191,0.12)',
            borderRadius: 6,
            padding: '3px 8px',
          }}
        >
          ANSWER
        </span>
        {/* ★ REQ-011-v2 dogfood-3 fix — 근거 충분도 라벨.
         *  옛: 항상 '근거 충분' (하드코딩). 신: fact 수 기준 4 단계
         *  ('부족'/'낮음'/'충분'/'풍부'). tooltip 으로 기준 안내. */}
        <span
          data-testid="recall-sufficiency-label"
          title={SUFFICIENCY_TOOLTIP}
          style={{
            fontSize: 11.5,
            color: '#5a8f86',
            cursor: 'help',
            borderBottom: '1px dotted #2f5952',
          }}
        >
          근거 {sufficiency.label}
        </span>
        {isExample && (
          <span
            className="font-mono"
            style={{
              fontSize: 8.5,
              letterSpacing: '0.06em',
              color: '#4a5d61',
              border: '1px solid #1f2e2c',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            예시
          </span>
        )}
        {/* ★ REQ-011-v2 dogfood-3 fix — 4 칸 충분도 바 (fact 수 기준 dynamic).
         *  1건 → 1/4, 2-4건 → 2/4, 5-10건 → 3/4, 11+건 → 4/4. */}
        <span
          data-testid="recall-sufficiency-bar"
          title={SUFFICIENCY_TOOLTIP}
          style={{ display: 'flex', gap: 3, marginLeft: 1, cursor: 'help' }}
        >
          {[1, 2, 3, 4].map((slot) => (
            <span
              key={slot}
              data-recall-sufficiency-slot={slot}
              data-recall-sufficiency-slot-filled={
                slot <= sufficiency.filled ? 'true' : 'false'
              }
              style={{
                width: 16,
                height: 4,
                borderRadius: 2,
                background: slot <= sufficiency.filled ? '#2DD4BF' : '#1c2f2c',
              }}
            />
          ))}
        </span>
      </div>
      <p
        data-testid="recall-answer-text"
        style={{
          margin: 0,
          fontSize: 17,
          lineHeight: 1.75,
          color: '#dde8e9',
          textWrap: 'pretty',
        }}
      >
        {answerText}
      </p>
      {chips.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 7,
            marginTop: 16,
          }}
        >
          {chips.map((c) => (
            <span
              key={c}
              data-testid="recall-answer-chip"
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                color: '#9af0e0',
                background: 'rgba(45,212,191,0.1)',
                border: '1px solid rgba(45,212,191,0.22)',
                borderRadius: 8,
                padding: '5px 11px',
              }}
            >
              {c}
            </span>
          ))}
        </div>
      )}
      <div
        data-testid="recall-honesty-line"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 18,
          paddingTop: 15,
          borderTop: '1px solid #14211e',
          fontSize: 12.5,
          color: '#647a7e',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M3 8.5l3 3 7-7"
            stroke="#5a8f86"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>
          이 답은 당신이 검증한 {confFacts}개의 사실에만 근거합니다. 그 밖은
          모릅니다.
        </span>
      </div>
    </div>
  );
}
