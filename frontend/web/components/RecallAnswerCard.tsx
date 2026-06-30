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
 */

interface Props {
  answerText: string;
  chips: string[];
  confFacts: number;
  /** "예시" 또는 "후속" 마커 표시 여부 (v1 = true). */
  isExample?: boolean;
}

export function RecallAnswerCard({
  answerText,
  chips,
  confFacts,
  isExample = true,
}: Props) {
  return (
    <div
      data-testid="recall-answer-card"
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
        <span style={{ fontSize: 11.5, color: '#5a8f86' }}>근거 충분</span>
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
        {/* 4 칸 충분도 바 (3/4 채움). */}
        <span style={{ display: 'flex', gap: 3, marginLeft: 1 }}>
          <span style={{ width: 16, height: 4, borderRadius: 2, background: '#2DD4BF' }} />
          <span style={{ width: 16, height: 4, borderRadius: 2, background: '#2DD4BF' }} />
          <span style={{ width: 16, height: 4, borderRadius: 2, background: '#2DD4BF' }} />
          <span style={{ width: 16, height: 4, borderRadius: 2, background: '#1c2f2c' }} />
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
