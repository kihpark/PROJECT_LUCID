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
 */

import type { RecallExampleFact } from '@/lib/recall-history';

interface Props {
  fact: RecallExampleFact;
  onSubjectClick?: (subject: string) => void;
}

export function RecallEvidenceCard({
  fact,
  onSubjectClick,
}: Props) {
  return (
    <div
      data-testid="recall-evidence-card"
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
          onClick={() => onSubjectClick?.(fact.s)}
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
          {fact.s}
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
          {fact.p}
        </span>
        {/* 목적어. */}
        <span
          data-testid="recall-evidence-object"
          style={{ color: '#cbd6d8' }}
        >
          {fact.o}
        </span>
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
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: '#7d9b95',
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: '#2f6f64',
            }}
          />
          {fact.src}
        </span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>검증 {fact.date}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{fact.by}</span>
      </div>
    </div>
  );
}
