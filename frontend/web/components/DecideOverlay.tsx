'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { ActionButton } from './ActionButton';
import { FactCard } from './FactCard';
import { DisambigCard } from './DisambigCard';
import {
  discardJob as apiDiscardJob,
  submitDecisions,
} from '@/lib/api';
import { notifyStateChanged } from '@/lib/sync';
import type {
  DecideResponse,
  FactAction,
  ObjectAction,
  PendingJobDetail,
} from '@/lib/types';

interface FactDecisionDraft {
  action: FactAction;
  editedClaim?: string;
  // B-34: structured edits. Each is optional — when the user toggles
  // Edit and only changes one field, the others fall back to the
  // fact's original triple. On submit we wrap the populated ones into
  // `edited_metadata` so the backend's `_coerce_fact_to_factnode`
  // overrides only the touched fields.
  editedSubjectUid?: string;
  editedPredicate?: string;
  editedObjectValue?: string;
}

interface ObjectDecisionDraft {
  action: ObjectAction;
  mergeTargetUid?: string;
}

interface Props {
  spaceId: string;
  jobId: string;
  initial: PendingJobDetail;
  // PR-4A-2: when set, an inline GraphNoteEditor is rendered under
  // every FactCard. /pending/[jobId]/review passes this.
  reviewMode?: boolean;
}

function buildDefaultDecisions(
  facts: PendingJobDetail['facts'],
): Record<string, FactDecisionDraft> {
  // B-31: every fact lands "accepted" by default — the user only
  // touches exceptions. Normal path is enter -> Submit (2 clicks).
  const next: Record<string, FactDecisionDraft> = {};
  for (const f of facts) {
    const uid = f.fact_uid || f.uid || '';
    if (!uid) continue;
    next[uid] = { action: 'accept' };
  }
  return next;
}

/**
 * Decide Overlay — B-31 checkbox model.
 *
 * Per-fact state held in one map (B-28 shared-state contract):
 *   factDecisions[uid].action === 'accept'  -> will land in the graph
 *   factDecisions[uid].action === 'edit'    -> will land with editedClaim
 *   factDecisions[uid].action === 'discard' -> will NOT land
 *
 * On entry every fact is pre-seeded with `{action: 'accept'}` so the
 * user only touches the exceptions. The card's checkbox toggles
 * accept <-> discard; Edit pops a textarea; the sticky Submit button
 * persists the whole map in one request.
 *
 * DR-083 (no bulk-accept without seeing): satisfied structurally —
 * the user has to navigate to this page, which always renders every
 * fact, before Submit is available. There is no off-screen path that
 * can ship a job.
 */
export function DecideOverlay({
  spaceId,
  jobId,
  initial,
  reviewMode = false,
}: Props) {
  const [factDecisions, setFactDecisions] = useState<
    Record<string, FactDecisionDraft>
  >(() => buildDefaultDecisions(initial.facts));
  const [objectDecisions, setObjectDecisions] = useState<
    Record<string, ObjectDecisionDraft>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DecideResponse | null>(null);

  const facts = initial.facts;
  const disambig = initial.disambiguation_pending;

  const counts = useMemo(() => {
    let accepted = 0;
    let edited = 0;
    let discarded = 0;
    for (const f of facts) {
      const uid = f.fact_uid || f.uid || '';
      if (!uid) continue;
      const d = factDecisions[uid];
      if (!d || d.action === 'accept') accepted++;
      else if (d.action === 'edit') edited++;
      else if (d.action === 'discard') discarded++;
    }
    return { accepted, edited, discarded, total: facts.length };
  }, [facts, factDecisions]);

  // Always dirty in B-31: landing populates every fact with a
  // default decision, so the user can hit Submit immediately. The
  // beforeunload guard now also fires from the moment the page
  // loads — that matches the model: leaving without Submit means
  // discarding the implicit acceptance.
  const hasDirtyDecisions = Object.keys(factDecisions).length > 0;

  useEffect(() => {
    if (!hasDirtyDecisions || result !== null) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasDirtyDecisions, result]);

  const onFactChange = (
    uid: string,
    next: {
      action: FactAction;
      editedClaim?: string;
      editedSubjectUid?: string;
      editedPredicate?: string;
      editedObjectValue?: string;
    },
  ) => {
    setFactDecisions((prev) => ({ ...prev, [uid]: next }));
  };

  const onDiscardJob = async () => {
    if (typeof window !== 'undefined' &&
        !window.confirm('Discard the entire job? This cannot be undone.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await apiDiscardJob(spaceId, jobId);
      setResult(r);
      // feat/popup-cleanup-discard-sync (PO #3): defensive 200ms wait
      // before the brief refetch fires. The backend commit returned, but
      // the AppShell badge listens via window event + BroadcastChannel
      // and re-reads /api/home/brief in response. A tiny delay guarantees
      // the refetch's transaction reads the committed state on databases
      // where the read replica lags the writer.
      // eslint-disable-next-line no-console
      console.debug('[DecideOverlay] discard done — waiting 200ms before notify');
      await new Promise(r => setTimeout(r, 200));
      notifyStateChanged('decision-submitted', { jobId, discarded: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        decisions: Object.entries(factDecisions).map(([fact_uid, d]) => {
          const edited_metadata: Record<string, unknown> = {};
          if (d.action === 'edit') {
            if (d.editedSubjectUid !== undefined) {
              edited_metadata.subject_uid = d.editedSubjectUid;
            }
            if (d.editedPredicate !== undefined) {
              edited_metadata.predicate = d.editedPredicate;
            }
            if (d.editedObjectValue !== undefined) {
              edited_metadata.object_value = d.editedObjectValue;
            }
          }
          return {
            fact_uid,
            action: d.action,
            edited_claim: d.action === 'edit' ? d.editedClaim : undefined,
            edited_metadata:
              d.action === 'edit' && Object.keys(edited_metadata).length > 0
                ? edited_metadata
                : undefined,
          };
        }),
        object_decisions: Object.entries(objectDecisions).map(
          ([candidate_id, d]) => ({
            candidate_id,
            action: d.action,
            merge_target_uid:
              d.action === 'merge_with' ? d.mergeTargetUid : undefined,
          }),
        ),
      };
      // decide-chip-click-bind: step 5 — submit payload trace. Open DevTools
      // verbose console to confirm the chip-selected entity_uid actually
      // hits the API (and isn't a stale "중국" the user typed before
      // clicking the chip).
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.debug('[DecideOverlay chip-click] 5. submit payload', payload);
      }
      const r = await submitDecisions(spaceId, jobId, payload);
      setResult(r);
      // fix/h1-state-sync-autorefresh: match the discard path's
      // defensive 200ms wait. The backend committed the SourceJob
      // status flip before returning DecideResponse, so Postgres
      // sees the new state immediately — but ES (this_week_validated,
      // facts count) lives behind a refresh_interval and the LEDGER
      // depends on it. A 200ms gap before fanning the notify gives
      // ES one indexing tick so brief, badge, and LEDGER agree on
      // numbers within the same render frame the user observes.
      // Pre-fix the Submit path fired notifyStateChanged synchronously
      // and the refetch could race the indexer.
      // eslint-disable-next-line no-console
      console.debug('[DecideOverlay] submit done — waiting 200ms before notify');
      await new Promise((r) => setTimeout(r, 200));
      // feat/state-sync-unification — broadcast so AppShell badge,
      // HomePage brief, LEDGER all refetch from backend truth.
      notifyStateChanged('decision-submitted', { jobId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-4 mb-2">
          <h1 className="text-xl font-light">Decide</h1>
        </div>
        <p className="text-sm text-text-secondary">
          <a
            href={initial.source_url}
            target="_blank"
            rel="noreferrer"
            className="hover:text-accent-cool underline"
          >
            {initial.source_url}
          </a>
        </p>
        <p className="text-xxs text-text-muted font-mono mt-1">
          {initial.source_type} · {initial.captured_from} · captured{' '}
          {new Date(initial.captured_at).toLocaleString()}
        </p>
      </header>

      <div
        className="mb-4 rounded-md border border-border-subtle bg-bg-elevated/40 p-3 text-xxs font-mono text-text-muted flex gap-3"
        data-testid="decision-counters"
      >
        <span>accepted: <span className="text-text-primary">{counts.accepted}</span></span>
        <span>edited: <span className="text-text-primary">{counts.edited}</span></span>
        <span>discarded: <span className="text-text-primary">{counts.discarded}</span></span>
      </div>

      {result && (
        <div
          className="mb-6 rounded-md border-2 border-accent-success/60 bg-accent-success/10 p-6 text-base"
          data-testid="decisions-recorded-panel"
          role="status"
          aria-live="polite"
        >
          <h2 className="text-lg font-medium text-accent-success mb-2">
            ✓ 검증 완료
          </h2>
          <p className="text-sm mb-4">
            <code className="font-mono">
              {result.accepted_facts.length}건 accept ·{' '}
              {result.edited_facts.length}건 edit ·{' '}
              {result.discarded_facts.length}건 discard
            </code>
            {' '}— validation_logs 에 영구 기록됨.
          </p>
          <Link
            href={'/pending' as Route}
            data-testid="back-to-pending"
            className="inline-flex items-center gap-1 text-sm text-accent-cool hover:underline"
          >
            ← Pending Queue 로 돌아가기
          </Link>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-accent-error/40 bg-accent-error/5 p-3 text-sm text-accent-error"
        >
          {error}
        </div>
      )}

      {result === null && (
      <section aria-label="Review">
        {disambig.length > 0 && (
          <div className="mb-6">
            <h2 className="text-sm font-medium text-accent-warm mb-2">
              {disambig.length} object(s) need disambiguation
            </h2>
            {disambig.map((d) => (
              <DisambigCard
                key={d.llm_uid}
                candidateId={d.llm_uid}
                candidateName={d.candidate_name}
                decisionReason={d.decision_reason}
                candidates={d.candidates}
                action={objectDecisions[d.llm_uid]?.action}
                mergeTargetUid={objectDecisions[d.llm_uid]?.mergeTargetUid}
                onChange={(next) =>
                  setObjectDecisions((prev) => ({
                    ...prev,
                    [d.llm_uid]: next,
                  }))
                }
              />
            ))}
          </div>
        )}

        {/* fix/decide-zero-fact-ux — 0 fact 케이스 명시 안내 */}
        {facts.length === 0 ? (
          <div
            data-testid="decide-empty-extract"
            className="mb-6 rounded-md border border-border-subtle bg-bg-elevated/40 p-6"
          >
            <h2 className="text-base font-medium text-text-primary mb-3">
              이 기사에서 추출 가능한 사실이 없었습니다
            </h2>
            <p className="text-sm text-text-secondary mb-4">
              LLM 이 단정적인 사실 진술을 찾지 못해 fact 0건으로 끝났어요.
              아래 폐기 버튼으로 이 추출을 정리할 수 있어요.
            </p>
            <div className="mb-5">
              <p className="text-xs text-text-muted mb-2">가능한 원인:</p>
              <ul className="list-disc list-inside text-xs text-text-muted space-y-1">
                <li>의견·해설 위주의 문장 구조 (사실 단정 부족)</li>
                <li>광고 또는 짧은 알림성 콘텐츠</li>
                <li>본문 자체 추출 실패</li>
              </ul>
            </div>
            <div className="flex items-center gap-3">
              <ActionButton
                variant="danger"
                disabled={busy}
                onClick={onDiscardJob}
              >
                이 추출 전체 폐기
              </ActionButton>
              <Link
                href={'/pending' as Route}
                data-testid="empty-back-to-pending"
                className="text-sm text-accent-cool hover:underline"
              >
                ← Pending Queue 로 돌아가기
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">
                {facts.length} fact(s) — uncheck or edit only the ones you disagree with
              </h2>
              <ActionButton
                variant="danger"
                disabled={busy}
                onClick={onDiscardJob}
              >
                이 추출 전체 폐기
              </ActionButton>
            </div>

            <div className="mb-4">
              {facts.map((f) => {
                const uid = f.fact_uid || f.uid || '';
                if (!uid) return null;
                const decision = factDecisions[uid] ?? { action: 'accept' as FactAction };
                return (
                  <FactCard
                    key={uid}
                    fact={f}
                    objects={initial.objects}
                    lang="en"
                    action={decision.action}
                    editedClaim={decision.editedClaim}
                    editedSubjectUid={decision.editedSubjectUid}
                    editedPredicate={decision.editedPredicate}
                    editedObjectValue={decision.editedObjectValue}
                    onChange={(next) => onFactChange(uid, next)}
                    reviewMode={reviewMode}
                    spaceId={spaceId}
                  />
                );
              })}
            </div>

            <div className="sticky bottom-0 bg-bg-base/95 py-4 -mx-4 px-4 border-t border-border-subtle">
              <ActionButton
                variant="primary"
                disabled={busy || facts.length === 0}
                onClick={onSubmit}
              >
                {busy ? "처리 중…" : "Submit decisions"}
              </ActionButton>
            </div>
          </>
        )}
      </section>
      )}
    </div>
  );
}
