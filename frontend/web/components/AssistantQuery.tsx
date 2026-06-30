/**
 * feat/hearth-oracle-merge — Inline assistant Q&A (H-1).
 *
 * ORACLE is absorbed into HEARTH. This component is the inline Q&A surface
 * embedded into the home page below the sphere + search input. It reuses
 * the ORACLE engine (postAssistantBrief + AssistantBriefResponse shape),
 * the M4a grounding guard (verified vs. inference separation), and the
 * existing card components — we deliberately do NOT rewrite the engine.
 *
 * The component is driven by props so the parent (HomePage) can:
 *   - receive a state callback (idle / listening / thinking / speaking)
 *     so it can sync the sphere animation,
 *   - pass the active spaceId from useAuthMe,
 *   - render the input itself (keeps the existing home search bar visual)
 *     and forward the query string here for submission.
 *
 * Block separation (preserves the M4a contract):
 *   - VerifiedFactCard (teal "검증됨") — P1, grounding-guarded
 *   - InferenceCard (gray "AI 추론 · 미보증") — P2, AI generation
 *   - NotGrounded message — when the engine cannot ground the answer
 *
 * Visual: matches the home page's centred-column layout. Stays under the
 * input (data-testid="assistant-result-inline") so the search bar remains
 * the anchor — the sphere stays the visual centrepiece.
 */
'use client';

import { useCallback, useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import { postAssistantBrief } from '@/lib/api';
import type {
  AssistantBriefResponse,
  VerifiedFactEntry,
} from '@/lib/types';
// ★ REQ-007-v1 (2026-06-30) — SphereAnimation 제거 → HearthSphere 로 교체.
import type { HearthSphereState as SphereState } from './HearthSphere';

const ACCENT = '#3fe0c6';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_SECONDARY = '#9db0b5';
const TEXT_DIM = '#647479';
const TEAL_BORDER = '#1a4a45';
const TEAL_LIGHT = 'rgba(63,224,198,0.06)';
const GRAY_BORDER = '#1c272b';

interface Props {
  spaceId: string;
  /** Parent-controlled state hook — let HomePage sync sphere animation. */
  onStateChange?: (state: SphereState) => void;
}

export interface AssistantQueryHandle {
  /** Imperative: submit a query string from outside (the home page's
   *  existing search input owns the text; we just receive the submission). */
  submit: (query: string) => Promise<void>;
  /** Clear the result + reset to idle (e.g. when input is cleared). */
  reset: () => void;
}

function VerifiedFactCard({ entry }: { entry: VerifiedFactEntry }) {
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
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
        <span style={{ color: ACCENT }}>{entry.subject}</span>{' '}
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
          {entry.predicate_label}
        </span>{' '}
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
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
        style={{
          fontSize: 17,
          color: TEXT_PRIMARY,
          lineHeight: 1.65,
          fontWeight: 500,
        }}
      >
        {inference}
      </div>
    </div>
  );
}

export const AssistantQuery = forwardRef<AssistantQueryHandle, Props>(
  function AssistantQuery({ spaceId, onStateChange }: Props, ref) {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<AssistantBriefResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Drive the parent sphere state from our internal status.
    useEffect(() => {
      if (!onStateChange) return;
      if (loading) {
        onStateChange('thinking');
      } else if (result) {
        onStateChange('speaking');
      } else {
        onStateChange('idle');
      }
    }, [loading, result, onStateChange]);

    const submit = useCallback(
      async (query: string) => {
        const q = query.trim();
        if (!q || !spaceId) return;
        setLoading(true);
        setError(null);
        setResult(null);
        try {
          const resp = await postAssistantBrief(q, spaceId);
          setResult(resp);
        } catch (err: unknown) {
          setError(
            err instanceof Error ? err.message : '오류가 발생했습니다.',
          );
        } finally {
          setLoading(false);
        }
      },
      [spaceId],
    );

    const reset = useCallback(() => {
      setResult(null);
      setError(null);
      setLoading(false);
    }, []);

    useImperativeHandle(
      ref,
      () => ({ submit, reset }),
      [submit, reset],
    );

    // Nothing to render unless the user has submitted or there is an error.
    if (!loading && !result && !error) {
      return null;
    }

    return (
      <section
        data-testid="assistant-result-inline"
        aria-label="질문 응답"
        style={{
          width: '100%',
          maxWidth: 620,
          margin: '24px auto 0',
          textAlign: 'left',
        }}
      >
        {loading && (
          <div
            data-testid="assistant-loading"
            style={{
              fontSize: 13,
              color: TEXT_DIM,
              padding: '12px 0',
              textAlign: 'center',
            }}
          >
            검증된 지식에서 답을 찾는 중...
          </div>
        )}

        {error && !loading && (
          <div
            data-testid="assistant-error"
            style={{
              color: '#c98b86',
              fontSize: 13,
              marginBottom: 20,
              padding: '12px 14px',
              border: `1px solid #2a1a1a`,
              borderRadius: 8,
              background: 'rgba(201,139,134,0.05)',
            }}
          >
            {error}
          </div>
        )}

        {result && !loading && (
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

            {result.inference && <InferenceCard inference={result.inference} />}

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
                  <VerifiedFactCard key={entry.fact_uid} entry={entry} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    );
  },
);

export default AssistantQuery;
