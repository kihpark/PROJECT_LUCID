'use client';

import { useState } from 'react';
import { ActionButton } from './ActionButton';
import type { PendingListFilters } from '@/lib/types';

interface Props {
  value: PendingListFilters;
  onChange: (next: PendingListFilters) => void;
}

const SOURCE_TYPES = ['web_article', 'youtube', 'pdf', 'image', 'highlighted_text'];

export function PendingFilters({ value, onChange }: Props) {
  const [draft, setDraft] = useState<PendingListFilters>(value);

  const apply = () => {
    onChange({ ...draft, offset: 0 });
  };

  const reset = () => {
    const empty: PendingListFilters = { offset: 0, limit: value.limit ?? 20 };
    setDraft(empty);
    onChange(empty);
  };

  return (
    <aside className="rounded-lg border border-border-subtle bg-bg-card p-4">
      <h2 className="text-xs uppercase tracking-wider text-text-muted font-mono mb-3">
        Filters
      </h2>
      <div className="space-y-3">
        <div>
          <label htmlFor="filter-source-type" className="block text-xs text-text-secondary mb-1">
            Source type
          </label>
          <select
            id="filter-source-type"
            value={draft.source_type ?? ''}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                source_type: e.target.value || undefined,
              }))
            }
            className="w-full rounded-md border border-border-subtle bg-bg-elevated p-2 text-xs"
          >
            <option value="">Any</option>
            {SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-text-secondary inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.has_negation_flag === true}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  has_negation_flag: e.target.checked ? true : undefined,
                }))
              }
            />
            Has negation
          </label>
          <label className="text-xs text-text-secondary inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.has_disambiguation === true}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  has_disambiguation: e.target.checked ? true : undefined,
                }))
              }
            />
            Has disambig
          </label>
        </div>

        <div className="flex gap-2 pt-2">
          <ActionButton variant="primary" onClick={apply}>
            Apply
          </ActionButton>
          <ActionButton variant="ghost" onClick={reset}>
            Reset
          </ActionButton>
        </div>
      </div>
    </aside>
  );
}
