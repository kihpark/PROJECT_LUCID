'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — 不知 (경계 밖) 상태.
 *
 * ★ 의뢰서 §0 verbatim:
 *   "不知 상태 = ★ 최우선 — '모릅니다 + 캡처'"
 *
 * ★ 의뢰서 §5 verbatim:
 *   "검증된 사실이 없을 때. 단순 '결과 없음' 절대 금지.
 *    1. '당신의 질문' 라벨 + 질문 인용 (22px).
 *    2. 검증된 영역 ↔ 그래프 밖 대비 카드:
 *       좌 (검증된 영역 — teal 노드 점들 + '사실 247 · 엔티티 89')
 *       | 점선 구분 |
 *       우 (그래프 밖 — 점선 '?' + '검증되지 않음').
 *    3. 선언 '그건 당신이 검증한 그래프 밖입니다.' (25px) +
 *       '저는 모릅니다. 검증되지 않은 것을 아는 척하지 않습니다.
 *        이 사실을 캡처해 검증하면, 다음부터 답할 수 있습니다.'
 *    4. CTA: [캡처해서 검증하기 →](teal) · [다른 질문하기](아웃라인)"
 *
 * 의뢰서 §5 verbatim 부기:
 *   "이 상태는 데이터 의존이 거의 없으므로 예시 배너 없이 깨끗하게,
 *    완성본으로 구현한다."
 *
 * 안심 문구 (사실/엔티티 카운트) = ★ PO 결정 1: brief.totals 실데이터.
 * brief 가 null 일 때 = 0 표시 (fail-soft).
 */

interface Props {
  queryText: string;
  /** ★ PO 결정 1 — brief.totals 실데이터 (null = 0). */
  factsCount: number;
  entitiesCount: number;
  onCapture?: () => void;
  onAskAgain?: () => void;
}

export function RecallUnknownState({
  queryText,
  factsCount,
  entitiesCount,
  onCapture,
  onAskAgain,
}: Props) {
  return (
    <div
      data-testid="recall-unknown-state"
      style={{ maxWidth: 680, margin: '18px auto 0' }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.06em',
          color: '#566569',
          marginBottom: 13,
        }}
      >
        당신의 질문
      </div>
      <h1
        data-testid="recall-unknown-question"
        style={{
          margin: '0 0 26px',
          fontSize: 22,
          fontWeight: 500,
          color: '#cdd9da',
          lineHeight: 1.4,
        }}
      >
        &quot;{queryText}&quot;
      </h1>

      {/* 검증된 영역 ↔ 그래프 밖 대비 카드. */}
      <div
        data-testid="recall-unknown-contrast"
        style={{
          display: 'flex',
          alignItems: 'stretch',
          background: 'rgba(12,19,22,0.6)',
          border: '1px solid #16211f',
          borderRadius: 18,
          overflow: 'hidden',
          marginBottom: 26,
        }}
      >
        {/* 좌: 검증된 영역. */}
        <div
          data-testid="recall-unknown-verified"
          style={{
            flex: 1,
            padding: '26px 22px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 13,
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.1em',
              color: '#4f9b8e',
            }}
          >
            검증된 영역
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 6,
              height: 30,
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: '#2DD4BF',
                boxShadow: '0 0 8px #2DD4BF',
              }}
            />
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#2DD4BF',
                boxShadow: '0 0 7px #2DD4BF',
                alignSelf: 'center',
              }}
            />
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#9af0e0',
                boxShadow: '0 0 8px #2DD4BF',
              }}
            />
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#2DD4BF',
                boxShadow: '0 0 6px #2DD4BF',
                alignSelf: 'flex-start',
              }}
            />
          </div>
          <div style={{ fontSize: 12.5, color: '#8aa0a5' }}>
            사실{' '}
            <b data-testid="recall-unknown-facts-count" style={{ color: '#cdd9da' }}>
              {factsCount}
            </b>{' '}
            ·{' '}
            엔티티{' '}
            <b data-testid="recall-unknown-entities-count" style={{ color: '#cdd9da' }}>
              {entitiesCount}
            </b>
          </div>
        </div>
        {/* 점선 구분. */}
        <div style={{ width: 0, borderLeft: '1px dashed #2a3a3e' }} />
        {/* 우: 그래프 밖. */}
        <div
          data-testid="recall-unknown-outside"
          style={{
            flex: 1,
            padding: '26px 22px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 13,
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.1em',
              color: '#5a686d',
            }}
          >
            그래프 밖
          </div>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              border: '1px dashed #46555a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              color: '#5a686d',
            }}
          >
            ?
          </div>
          <div style={{ fontSize: 12.5, color: '#5a686d' }}>검증되지 않음</div>
        </div>
      </div>

      <h2
        data-testid="recall-unknown-declaration"
        style={{
          margin: '0 0 12px',
          fontSize: 25,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: '#f1f6f7',
        }}
      >
        그건 당신이 검증한 그래프 밖입니다.
      </h2>
      <p
        style={{
          margin: '0 0 26px',
          fontSize: 16,
          lineHeight: 1.7,
          color: '#9db0b5',
        }}
      >
        저는 모릅니다. 검증되지 않은 것을 아는 척하지 않습니다. 이 사실을
        캡처해 검증하면, 다음부터 답할 수 있습니다.
      </p>
      <div style={{ display: 'flex', gap: 11 }}>
        <button
          type="button"
          data-testid="recall-unknown-cta-capture"
          onClick={onCapture}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: '#2DD4BF',
            color: '#06201c',
            fontWeight: 600,
            fontSize: 14,
            border: 'none',
            borderRadius: 12,
            padding: '13px 20px',
            cursor: 'pointer',
            boxShadow: '0 0 28px rgba(45,212,191,0.22)',
          }}
        >
          캡처해서 검증하기 →
        </button>
        <button
          type="button"
          data-testid="recall-unknown-cta-ask-again"
          onClick={onAskAgain}
          style={{
            background: 'none',
            border: '1px solid #1d2b2f',
            color: '#8aa0a5',
            fontSize: 14,
            borderRadius: 12,
            padding: '13px 18px',
            cursor: 'pointer',
          }}
        >
          다른 질문하기
        </button>
      </div>
    </div>
  );
}
