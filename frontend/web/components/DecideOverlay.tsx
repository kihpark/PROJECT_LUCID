'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActionButton } from './ActionButton';
import { LangToggle, type Lang } from './LangToggle';
import { FactCard } from './FactCard';
import { DisambigCard } from './DisambigCard';
import {
  discardJob as apiDiscardJob,
  submitDecisions,
} from '@/lib/api';
import type {
  DecideResponse,
  FactAction,
  ObjectAction,
  PendingJobDetail,
} from '@/lib/types';

interface FactDecisionDraft {
  action: FactAction;
  editedClaim?: string;
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

/**
 * Decide Overlay — single shared state model (B-28 + B-29).
 *
 * Per-fact state held in one map:
 *   factDecisions[uid] absent           -> undecided
 *   factDecisions[uid].action === 'accept'  -> accepted
 *   factDecisions[uid].action === 'edit'    -> edited
 *   factDecisions[uid].action === 'discard' -> discarded
 *
 * B-29 defect 2 collapsed the previous accept-all / review tabs
 * into a SINGLE Review surface. The Accept-all action is now a
 * button rendered ABOVE the fact list, never a separate tab. The
 * user always sees the facts before the bulk button is offered —
 * DR-083 (no bulk-accept without seeing) is satisfied by surface,
 * not by guard. Submit is a sticky footer button.
 */
export function DecideOverlay({
  spaceId,
  jobId,
  initial,
  reviewMode = false,
}: Props) {
  const [lang, setLang] = useState<Lang>('en');
  const [factDecisions, setFactDecisions] = useState<
    Record<string, FactDecisionDraft>
  >({});
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
    let undecided = 0;
    for (const f of facts) {
      const uid = f.fact_uid || f.uid || '';
      if (!uid) continue;
      const d = factDecisions[uid];
      if (!d) undecided++;
      else if (d.action === 'accept') accepted++;
      else if (d.action === 'edit') edited++;
      else if (d.action === 'discard') discarded++;
    }
    return { accepted, edited, discarded, undecided, total: facts.length };
  }, [facts, factDecisions]);

  const hasDirtyDecisions =
    Object.keys(factDecisions).length + Object.keys(objectDecisions).length > 0;

  // beforeunload guard
  useEffect(() => {
    if (!hasDirtyDecisions) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasDirtyDecisions]);

  const onFactChange = (
    uid: string,
    next: { action: FactAction; editedClaim?: string },
  ) => {
    setFactDecisions((prev) => ({ ...prev, [uid]: next }));
  };

  const onFactUndo = (uid: string) => {
    setFactDecisions((prev) => {
      if (!(uid in prev)) return prev;
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  };

  // Accept-all: B-28 behaviour preserved. State transition (undecided
  // -> accept, preserve edited/discarded) followed by submit.
  const onAcceptAllAndSubmit = async () => {
    if (facts.length === 0 || counts.undecided === 0) return;
    setBusy(true);
    setError(null);
    try {
      const nextDecisions: Record<string, FactDecisionDraft> = {
        ...factDecisions,
      };
      for (const f of facts) {
        const uid = f.fact_uid || f.uid || '';
        if (!uid) continue;
        if (!(uid in nextDecisions)) {
          nextDecisions[uid] = { action: 'accept' };
        }
      }
      setFactDecisions(nextDecisions);
      const r = await submitDecisions(spaceId, jobId, {
        decisions: Object.entries(nextDecisions).map(([fact_uid, d]) => ({
          fact_uid,
          action: d.action,
          edited_claim: d.action === 'edit' ? d.editedClaim : undefined,
        })),
        object_decisions: Object.entries(objectDecisions).map(
          ([candidate_id, d]) => ({
            candidate_id,
            action: d.action,
            merge_target_uid:
              d.action === 'merge_with' ? d.mergeTargetUid : undefined,
          }),
        ),
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
        decisions: Object.entries(factDecisions).map(([fact_uid, d]) => ({
          fact_uid,
          action: d.action,
          edited_claim: d.action === 'edit' ? d.editedClaim : undefined,
        })),
        object_decisions: Object.entries(objectDecisions).map(
          ([candidate_id, d]) => ({
            candidate_id,
            action: d.action,
            merge_target_uid:
              d.action === 'merge_with' ? d.mergeTargetUid : undefined,
          }),
        ),
      };
      const r = await submitDecisions(spaceId, jobId, payload);
      setResult(r);
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
          <LangToggle value={lang} onChange={setLang} />
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
        <span>undecided: <span className="text-text-primary">{counts.undecided}</span></span>
      </div>

      {result && (
        <div className="mb-4 rounded-md border border-accent-success/40 bg-accent-success/5 p-3 text-sm">
          Decisions recorded —{' '}
          <code className="font-mono">
            {result.accepted_facts.length} accepted,{' '}
            {result.edited_facts.length} edited,{' '}
            {result.discarded_facts.length} discarded
          </code>
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

        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">
            {facts.length} pending fact(s)
          </h2>
          <div className="flex gap-2">
            <ActionButton
              variant="primary"
              disabled={busy || facts.length === 0 || counts.undecided === 0}
              onClick={onAcceptAllAndSubmit}
            >
              Accept all {counts.undecided} undecided
            </ActionButton>
            <ActionButton
              variant="danger"
              disabled={busy}
              onClick={onDiscardJob}
            >
              Discard job
            </ActionButton>
          </div>
        </div>

        <div className="mb-4">
          {facts.map((f) => {
            const uid = f.fact_uid || f.uid || '';
            if (!uid) return null;
            return (
              <FactCard
                key={uid}
                fact={f}
                objects={initial.objects}
                lang={lang}
                action={factDecisions[uid]?.action}
                editedClaim={factDecisions[uid]?.editedClaim}
                onChange={(next) => onFactChange(uid, next)}
                onUndo={() => onFactUndo(uid)}
                reviewMode={reviewMode}
                spaceId={spaceId}
              />
            );
          })}
        </div>

        <div className="sticky bottom-0 bg-bg-base/95 py-4 -mx-4 px-4 border-t border-border-subtle">
          <ActionButton
            variant="primary"
            disabled={busy || !hasDirtyDecisions}
            onClick={onSubmit}
          >
            Submit decisions
          </ActionButton>
        </div>
      </section>
    </div>
  );
}
