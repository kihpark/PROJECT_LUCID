'use client';

import { useState } from 'react';
import { postAssistantBrief } from '@/lib/api';
import type { AssistantBriefResponse, VerifiedFactEntry } from '@/lib/types';

const BG = '#06080b';
const ACCENT = '#3fe0c6';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_SECONDARY = '#9db0b5';
const TEXT_DIM = '#647479';
const CARD_BG = '#0c1316';
const TEAL_BORDER = '#1a4a45';
const TEAL_LIGHT = 'rgba(63,224,198,0.06)';
const GRAY_BORDER = '#1c272b';

interface Props {
  spaceId: string;
}

function VerifiedCard({ entry }: { entry: VerifiedFactEntry }) {
  return (
    <div
      data-testid="verified-fact-card"
      style={{
        border: `1px solid ${TEAL_BORDER}`,
        background: TEAL_LIGHT,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          data-testid="verified-badge"
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: ACCENT,
            background: 'rgba(63,224,198,0.12)',
            border: `1px solid ${ACCENT}`,
            borderRadius: 4,
            padding: '2px 7px',
            letterSpacing: '0.04em',
          }}
        >
          검증됨
        </span>
      </div>
      <div style={{ fontSize: 14, color: TEXT_PRIMARY, lineHeight: 1.5 }}>
        <span style={{ color: ACCENT }}>{entry.subject}</span>
        {' '}
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>{entry.predicate_label}</span>
        {' '}
        <span>{entry.object}</span>
      </div>
      {entry.sources.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: TEXT_DIM }}>
          출처: {entry.sources.length}건
        </div>
      )}
    </div>
  );
}

function InferenceCard({ inference }: { inference: string }) {
  return (
    <div
      data-testid="inference-card"
      data-variant="primary"
      style={{
        border: `1px solid ${GRAY_BORDER}`,
        background: '#0a1115',
        borderRadius: 12,
        padding: '20px 22px',
        marginBottom: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span
          data-testid="inference-answer-chip"
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: TEXT_PRIMARY,
            background: '#1b242a',
            border: `1px solid ${GRAY_BORDER}`,
            borderRadius: 4,
            padding: '2px 7px',
            letterSpacing: '0.04em',
          }}
        >
          AI 답변
        </span>
        <span
          data-testid="inference-label"
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: TEXT_DIM,
            background: '#151f24',
            border: `1px solid ${GRAY_BORDER}`,
            borderRadius: 4,
            padding: '2px 7px',
          }}
        >
          AI 추론 · 미보증
        </span>
      </div>
      <div
        data-testid="inference-body"
        style={{ fontSize: 17, color: TEXT_PRIMARY, lineHeight: 1.65, fontWeight: 500 }}
      >
        {inference}
      </div>
    </div>
  );
}

export function AssistantView({ spaceId }: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AssistantBriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || !spaceId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await postAssistantBrief(query.trim(), spaceId);
      setResult(resp);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '40px 24px',
        color: TEXT_PRIMARY,
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: TEXT_PRIMARY }}>
        어시스턴트
      </h1>
      <p style={{ fontSize: 13, color: TEXT_DIM, marginBottom: 28 }}>
        검증된 지식 그래프에 근거한 답변을 제공합니다.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10, marginBottom: 32 }}>
        <input
          data-testid="assistant-query-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="무엇이 궁금하세요?"
          style={{
            flex: 1,
            background: CARD_BG,
            border: `1px solid ${GRAY_BORDER}`,
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 14,
            color: TEXT_PRIMARY,
            outline: 'none',
          }}
        />
        <button
          data-testid="assistant-submit-button"
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            background: ACCENT,
            color: BG,
            border: 'none',
            borderRadius: 8,
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 700,
            cursor: loading ? 'default' : 'pointer',
            opacity: loading || !query.trim() ? 0.5 : 1,
          }}
        >
          {loading ? '처리 중...' : '전송'}
        </button>
      </form>

      {error && (
        <div style={{ color: '#c98b86', fontSize: 13, marginBottom: 20 }}>
          {error}
        </div>
      )}

      {result && (
        <div data-testid="assistant-result">
          {!result.grounded && (
            <div
              data-testid="not-grounded-message"
              style={{
                background: '#12181c',
                border: `1px solid ${GRAY_BORDER}`,
                borderRadius: 10,
                padding: '16px',
                marginBottom: 16,
                color: TEXT_SECONDARY,
                fontSize: 14,
              }}
            >
              이 주제는 검증된 지식에 없습니다.
            </div>
          )}

          {result.inference && (
            <InferenceCard inference={result.inference} />
          )}

          {result.grounded && result.verified.length > 0 && (
            <div data-testid="verified-section" style={{ marginBottom: 16 }}>
              <div
                data-testid="verified-section-header"
                style={{
                  fontSize: 11,
                  color: TEXT_DIM,
                  marginBottom: 10,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                근거 사실 {result.verified.length}건
              </div>
              {result.verified.map((entry) => (
                <VerifiedCard key={entry.fact_uid} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
