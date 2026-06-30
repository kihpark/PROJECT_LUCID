'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — 예시 데이터 배너.
 *
 * 의뢰서 §0 verbatim:
 *   "'예시 데이터(REQ-004 후 실연결)' 상태 배너 — 토글 가능하게.
 *    가짜 수치를 진짜처럼 보이게 하지 말 것 — showStatus 배너가 그 역할."
 *
 * 의뢰서 §4-2 verbatim 카피:
 *   "REQ-004 · 사실·신뢰지표·근거 그래프는 예시 데이터입니다 —
 *    실연결은 메타네트워크 재구축(REQ-004) 후. 레이아웃·동선은 확정."
 *
 * default ON (PO 의뢰서 §11-5 acceptance: "예시·후속으로 명확히 표시").
 */

interface Props {
  show: boolean;
  onToggle?: () => void;
}

export function RecallExampleBanner({ show, onToggle }: Props) {
  if (!show) return null;
  return (
    <div
      data-testid="recall-example-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '0 0 22px',
        padding: '10px 14px',
        background: 'rgba(45,212,191,0.05)',
        border: '1px solid #16302b',
        borderLeft: '2px solid #2DD4BF',
        borderRadius: 10,
      }}
    >
      <span
        className="font-mono"
        style={{
          flex: 'none',
          fontSize: 9,
          letterSpacing: '0.08em',
          color: '#0a1513',
          background: '#5fbfae',
          borderRadius: 5,
          padding: '2px 7px',
        }}
      >
        REQ-004
      </span>
      <span
        style={{
          fontSize: 11.5,
          lineHeight: 1.5,
          color: '#7d9b95',
          flex: 1,
        }}
      >
        사실·신뢰지표·근거 그래프는{' '}
        <b style={{ color: '#a7c4be' }}>예시 데이터</b>입니다 — 실연결은
        메타네트워크 재구축(REQ-004) 후. 레이아웃·동선은 확정.
      </span>
      {onToggle && (
        <button
          type="button"
          data-testid="recall-example-banner-toggle"
          onClick={onToggle}
          aria-label="예시 배너 닫기"
          style={{
            flex: 'none',
            background: 'transparent',
            border: '1px solid #1f2e2c',
            color: '#5fbfae',
            fontSize: 11,
            borderRadius: 6,
            padding: '3px 8px',
            cursor: 'pointer',
          }}
        >
          닫기
        </button>
      )}
    </div>
  );
}
