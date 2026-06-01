'use client';

import { ActionButton } from './ActionButton';
import type {
  ObjectAction,
  DisambigCandidate,
} from '@/lib/types';

interface Props {
  candidateId: string;
  candidateName: string;
  decisionReason: string;
  candidates: DisambigCandidate[];
  action?: ObjectAction;
  mergeTargetUid?: string;
  onChange: (next: { action: ObjectAction; mergeTargetUid?: string }) => void;
}

export function DisambigCard({
  candidateId,
  candidateName,
  decisionReason,
  candidates,
  action,
  mergeTargetUid,
  onChange,
}: Props) {
  return (
    <article
      data-testid={`disambig-card-${candidateId}`}
      className="rounded-lg border border-accent-warm/40 bg-bg-card p-4 mb-3"
    >
      <header className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium">
          <span className="text-accent-warm">⚡</span> {candidateName}
        </h3>
        <code className="text-xxs text-text-muted font-mono">
          {decisionReason}
        </code>
      </header>
      <p className="text-xxs text-text-secondary mb-3">
        Multiple existing objects match this candidate. Pick one to merge into,
        create a separate object, or skip and decide later.
      </p>
      <ul className="space-y-2 mb-3">
        {candidates.map((c) => {
          const selected = action === 'merge_with' && mergeTargetUid === c.object_uid;
          return (
            <li key={c.object_uid}>
              <button
                type="button"
                onClick={() =>
                  onChange({ action: 'merge_with', mergeTargetUid: c.object_uid })
                }
                className={[
                  'w-full text-left rounded-md border p-2 text-sm transition-colors',
                  selected
                    ? 'border-accent-cool bg-accent-cool/10'
                    : 'border-border-subtle hover:bg-bg-card-hover',
                ].join(' ')}
              >
                <div className="flex items-baseline justify-between">
                  <span>{c.name}</span>
                  <code className="text-xxs text-text-muted font-mono">
                    {c.object_class} · {c.score.toFixed(2)}
                  </code>
                </div>
                <code className="text-xxs text-text-muted font-mono">
                  {c.object_uid}
                </code>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <ActionButton
          variant={action === 'create_new' ? 'primary' : 'secondary'}
          active={action === 'create_new'}
          onClick={() => onChange({ action: 'create_new' })}
        >
          Create new
        </ActionButton>
        <ActionButton
          variant={action === 'skip' ? 'secondary' : 'ghost'}
          active={action === 'skip'}
          onClick={() => onChange({ action: 'skip' })}
        >
          Skip
        </ActionButton>
      </div>
    </article>
  );
}
