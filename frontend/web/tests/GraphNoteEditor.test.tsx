import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GraphNoteEditor } from '@/components/GraphNoteEditor';
import type { GraphNote } from '@/lib/types';

const existing: GraphNote[] = [
  {
    id: 'note-1',
    fact_uid: 'fn-1',
    note: 'First note',
    created_at: new Date('2026-06-01T10:00:00Z').toISOString(),
    updated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
  },
];

vi.mock('@/lib/api', () => ({
  listNotes: vi.fn(async () => existing),
  createNote: vi.fn(async (_s: string, factUid: string, note: string) => ({
    id: 'note-2',
    fact_uid: factUid,
    note,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })),
  deleteNote: vi.fn(async () => undefined),
  ApiError: class extends Error {
    status = 0;
    detail: string | undefined;
  },
}));

import * as api from '@/lib/api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GraphNoteEditor', () => {
  it('lists existing notes on mount', async () => {
    render(<GraphNoteEditor spaceId="ks-1" factUid="fn-1" />);
    await waitFor(() => expect(api.listNotes).toHaveBeenCalled());
    expect(await screen.findByText('First note')).toBeInTheDocument();
  });

  it('adds a new note via createNote', async () => {
    render(<GraphNoteEditor spaceId="ks-1" factUid="fn-1" />);
    await waitFor(() => expect(api.listNotes).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), {
      target: { value: 'A new note' },
    });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith('ks-1', 'fn-1', 'A new note'));
    expect(await screen.findByText('A new note')).toBeInTheDocument();
  });

  it('deletes a note via deleteNote', async () => {
    render(<GraphNoteEditor spaceId="ks-1" factUid="fn-1" />);
    await waitFor(() => expect(api.listNotes).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('Delete'));
    await waitFor(() =>
      expect(api.deleteNote).toHaveBeenCalledWith('ks-1', 'fn-1', 'note-1'),
    );
  });
});
