'use client';

import { useEffect, useState, useCallback } from 'react';
import { ActionButton } from './ActionButton';
import { createNote, deleteNote, listNotes, ApiError } from '@/lib/api';
import type { GraphNote } from '@/lib/types';

interface Props {
  spaceId: string;
  factUid: string;
}

export function GraphNoteEditor({ spaceId, factUid }: Props) {
  const [notes, setNotes] = useState<GraphNote[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const fetched = await listNotes(spaceId, factUid);
      setNotes(fetched);
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  }, [spaceId, factUid]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createNote(spaceId, factUid, draft);
      setNotes((prev) => [...prev, created]);
      setDraft('');
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (noteId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteNote(spaceId, factUid, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.detail ?? err.message : (err as Error).message;
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid={`graph-note-editor-${factUid}`}
      className="border-t border-border-subtle pt-3 mt-3"
    >
      <h4 className="text-xs uppercase tracking-wider text-text-muted font-mono mb-2">
        Notes
      </h4>
      {error && (
        <p role="alert" className="text-accent-error text-xs mb-2">
          {error}
        </p>
      )}
      {notes.length === 0 && !busy && (
        <p className="text-xs text-text-muted">No notes yet.</p>
      )}
      <ul className="space-y-2 mb-3">
        {notes.map((n) => (
          <li
            key={n.id}
            className="rounded-md border border-border-subtle bg-bg-elevated p-2 text-xs"
          >
            <p className="whitespace-pre-wrap mb-1">{n.note}</p>
            <div className="flex items-center justify-between">
              <code className="text-text-muted font-mono">
                {new Date(n.created_at).toLocaleString()}
              </code>
              <button
                type="button"
                onClick={() => remove(n.id)}
                disabled={busy}
                className="text-accent-error hover:underline disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note..."
          maxLength={8000}
          className="flex-1 rounded-md border border-border-subtle bg-bg-elevated p-2 text-xs focus:outline-none focus:border-accent-cool"
          rows={2}
        />
        <ActionButton variant="secondary" onClick={add} disabled={busy || !draft.trim()}>
          Add
        </ActionButton>
      </div>
    </section>
  );
}
