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

type TabValue = 'review' | 'accept_all';

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

/**
 * Decide Overlay — single shared state model (B-28).
 *
 * Per-fact state is a discriminated union held in one map:
 *   factDecisions[uid] absent           -> undecided
 *   factDecisions[uid].action === 'accept'  -> accepted
 *   factDecisions[uid].action === 'edit'    -> edited (with editedClaim)
 *   factDecisions[uid].action === 'discard' -> discarded
 *
 * Both tabs (Review and Accept-all) read and write this same map.
 * The Accept-all action is a state TRANSITION (undecided -> accept on
 * every fact that hasn\'t been touched) followed by an immediate
 * submit; edited / discarded facts are preserved as-is. Submit alone
 * persists the current state to validation_logs.
 *
 * DR-083 (guardrail): Accept-all is only enabled when facts are
 * rendered on screen, matching the voice path\'s ban on
 * "bulk-accept-without-seeing".
 */
export function DecideOverlay({
  spaceId,
  jobId,
  initial,
  reviewMode = false,
}: Props) {
  const [lang, setLang] = useState<Lang>('en');
  // B-28 D-1: default lands on Review so the user reads facts before
  // any bulk action. The accept_all tab is the explicit bulk-action
  // surface, not the default.
  const [tab, setTab] = useState<TabValue>('review');
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

  // ---------------------------------------------------------------------------
  // State mutators (the only paths that write to factDecisions)
  // ---------------------------------------------------------------------------

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

  // B-28 D-3/D-4: Accept-all is a state transition (preserve
  // edited/discarded, set undecided -> accept) + submit. Both tabs
  // observe the same factDecisions map so the post-transition state
  // shows up under the per-card buttons on the Review tab too.
  const onAcceptAllAndSubmit = async () => {
    if (facts.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // 1) Compute the next decisions map: preserve every existing
      //    entry, fill missing slots with 'accept'.
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

      // 2) Reflect into local state immediately so the UI (Review tab,
      //    counters) shows the post-transition view even if the API
      //    call is slow.
      setFactDecisions(nextDecisions);

      // 3) Submit the unified payload.
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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
          active={tab === 'review'}
          onClick={() => setTab('review')}
          role="tab"
          aria-selected={tab === 'review'}
        >
          Review
        </ActionButton>
        <ActionButton
          variant="ghost"
          active={tab === 'accept_all'}
          onClick={() => setTab('accept_all')}
          role="tab"
          aria-selected={tab === 'accept_all'}
        >
          Accept all ({facts.length})
        </ActionButton>
      </div>

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

      {tab === 'accept_all' ? (
        <section aria-label="Accept all">
          <p className="text-sm text-text-secondary mb-4">
            Accept every undecided fact in one step. Facts you have
            already edited or discarded are preserved as-is.
            Disambiguations stay in the queue and will surface on the
            next visit.
          </p>
          <ul className="mb-4 list-disc list-inside text-sm text-text-secondary max-h-60 overflow-auto">
            {facts.map((f) => {
              const uid = f.fact_uid || f.uid || '';
              const state = factDecisions[uid]?.action ?? 'undecided';
              return (
                <li key={uid} data-testid={`accept-all-row-${uid}`}>
                  <span lang={lang === 'kr' ? 'ko' : 'en'}>
                    {lang === 'en' ? (f.claim_en || f.claim) : f.claim}
                  </span>{' '}
                  <span className="text-xxs font-mono text-text-muted">[{state}]</span>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <ActionButton
              variant="primary"
              disabled={busy || facts.length === 0 || counts.undecided === 0}
              onClick={onAcceptAllAndSubmit}
            >
              Accept all {counts.undecided} undecided and submit
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
      )}
    </div>
  );
}
