'use client';

import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton';
import { LangToggle, type Lang } from './LangToggle';
import { FactCard } from './FactCard';
import { DisambigCard } from './DisambigCard';
import {
  acceptAll as apiAcceptAll,
  discardJob as apiDiscardJob,
  submitDecisions,
} from '@/lib/api';
import type {
  DecideResponse,
  FactAction,
  ObjectAction,
  PendingJobDetail,
} from '@/lib/types';

type TabValue = 'accept_all' | 'review';

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
  // PR-4A-2: when set, the Review tab renders an inline GraphNoteEditor
  // under every FactCard. /pending/[jobId]/review passes this.
  reviewMode?: boolean;
}

export function DecideOverlay({
  spaceId,
  jobId,
  initial,
  reviewMode = false,
}: Props) {
  const [lang, setLang] = useState<Lang>('en');
  const [tab, setTab] = useState<TabValue>(reviewMode ? 'review' : 'accept_all');
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

  const onAcceptAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiAcceptAll(spaceId, jobId);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDiscardJob = async () => {
    if (!confirm('Discard the entire job? This cannot be undone.')) return;
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

      <div className="flex gap-2 mb-4" role="tablist" aria-label="Decide mode">
        <ActionButton
          variant="ghost"
          active={tab === 'accept_all'}
          onClick={() => setTab('accept_all')}
          role="tab"
          aria-selected={tab === 'accept_all'}
        >
          Accept all ({facts.length})
        </ActionButton>
        <ActionButton
          variant="ghost"
          active={tab === 'review'}
          onClick={() => setTab('review')}
          role="tab"
          aria-selected={tab === 'review'}
        >
          Review
        </ActionButton>
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

      {tab === 'accept_all' ? (
        <section aria-label="Accept all">
          <p className="text-sm text-text-secondary mb-4">
            Accept every pending fact without per-card review. Disambiguations
            stay in the queue and will surface on the next visit.
          </p>
          <div className="flex gap-2">
            <ActionButton
              variant="primary"
              disabled={busy || facts.length === 0}
              onClick={onAcceptAll}
            >
              Accept all {facts.length} facts
            </ActionButton>
            <ActionButton
              variant="danger"
              disabled={busy}
              onClick={onDiscardJob}
            >
              Discard job
            </ActionButton>
          </div>
        </section>
      ) : (
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

          <div className="mb-4">
            <h2 className="text-sm font-medium mb-2">
              {facts.length} pending fact(s)
            </h2>
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
                  onChange={(next) =>
                    setFactDecisions((prev) => ({
                      ...prev,
                      [uid]: next,
                    }))
                  }
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
      )}
    </div>
  );
}
