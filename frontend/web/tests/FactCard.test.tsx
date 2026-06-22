import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FactCard } from '@/components/FactCard';
import type { FactSummary, ObjectSummary } from '@/lib/types';

// Mock api module
vi.mock('@/lib/api', () => ({
  searchEntitySuggestions: vi.fn(async () => []),
  listPredicates: vi.fn(async () => []),
}));

import * as api from '@/lib/api';

const baseFact: FactSummary = {
  fact_uid: 'fn-1',
  claim: 'AI 가 일자리를 대체한다.',
  claim_en: 'AI will replace jobs.',
  type: 'proposition',
  subject_uid: 'obj-1',
  predicate: 'will_replace',
  object_value: 'jobs',
  negation_flag: false,
  negation_scope: null,
};

const baseObjects: ObjectSummary[] = [
  {
    uid: 'obj-1',
    class: 'organization',
    name: '서울외환시장운영협의회',
    name_en: 'Seoul FX Market Operations Council',
    properties: {},
  },
  {
    uid: 'obj-2',
    class: 'concept',
    name: '운영시간',
    name_en: 'operating hours',
    properties: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.listPredicates as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('FactCard — claim display', () => {
  it('renders the claim in the chosen language', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    expect(screen.getByText('AI will replace jobs.')).toBeInTheDocument();
  });

  it('falls back to KR claim when claim_en missing on en lang', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, claim_en: null }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByText('AI 가 일자리를 대체한다.')).toBeInTheDocument();
  });

  it('shows a negation warning when negation_flag is true', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'partial' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('negation_flag');
    expect(screen.getByRole('status')).toHaveTextContent('partial');
  });
});

describe('FactCard — checkbox model (B-31)', () => {
  it('renders a checked checkbox when action is accept', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('renders a checked checkbox when action is edit', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedClaim="changed"
        lang="en"
        onChange={onChange}
      />,
    );
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('renders an unchecked checkbox when action is discard', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('unchecking emits action discard', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    expect(onChange).toHaveBeenCalledWith({ action: 'discard' });
  });

  it('Edit button is disabled on a discarded fact', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    expect(screen.getByText('Edit')).toBeDisabled();
  });

  it('does not render an Accept button (the checkbox replaces it)', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

describe('FactCard — structured S/P/O editor (B-34)', () => {
  it('Edit click reveals subject / predicate / object inputs', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    rerender(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-edit-subject-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-edit-predicate-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-edit-object-fn-1')).toBeInTheDocument();
  });

  it('does not render a free-text claim textarea any more', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.queryByPlaceholderText(/Edited claim/i)).toBeNull();
  });

  it('subject input is a text input (not a select)', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const subjectInput = screen.getByTestId('fact-edit-subject-fn-1');
    expect(subjectInput.tagName).toBe('INPUT');
    expect(subjectInput).toHaveAttribute('type', 'text');
  });

  it('typing into subject input emits editedSubjectUid as typed literal', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'obj-2' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedSubjectUid: 'obj-2',
      }),
    );
  });

  it('changing the predicate emits the new predicate + regenerated claim', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-predicate-fn-1'), {
      target: { value: 'may_replace' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedPredicate: 'may_replace',
        editedClaim: expect.stringContaining('may_replace'),
      }),
    );
  });

  it('typing a known entity name into object auto-resolves to its uid', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-object-fn-1'), {
      target: { value: '운영시간' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        editedObjectValue: 'obj-2',
      }),
    );
  });

  it('typing a literal value into object keeps it as a literal', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-object-fn-1'), {
      target: { value: '85.7 billion USD' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        editedObjectValue: '85.7 billion USD',
      }),
    );
  });

  it('preview line reflects the live triple', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-edit-preview-fn-1')).toHaveTextContent(
      /Seoul FX Market Operations Council\s*\|\s*will_replace\s*\|\s*jobs/,
    );
  });
});

describe('FactCard — entity label resolution (B-27 + B-31 regression)', () => {
  it('resolves subject_uid "obj-1" to the Korean name in KR mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent(
      '서울외환시장운영협의회',
    );
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-1');
  });

  it('resolves subject_uid to name_en in EN mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent(
      'Seoul FX Market Operations Council',
    );
  });

  it('shows "(미해석)" marker when subject_uid is obj-N but not in objects', () => {
    const onChange = vi.fn();
    const fact: FactSummary = { ...baseFact, subject_uid: 'obj-99' };
    render(
      <FactCard
        fact={fact}
        objects={baseObjects}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('obj-99');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(미해석)');
  });

  it('einfomax SpaceX/Goldman Sachs regression: distinct refs resolve to distinct labels', () => {
    const spacexFacts: FactSummary[] = [
      {
        fact_uid: 'fn-1',
        claim: 'SpaceX의 상장 주관사단이 그린슈 옵션을 행사했다.',
        subject_uid: 'obj-2',
        predicate: 'exercised',
        object_value: 'greenshoe option',
      },
      {
        fact_uid: 'fn-2',
        claim: 'SpaceX는 총 857억달러를 조달했다.',
        subject_uid: 'obj-1',
        predicate: 'total_funds_raised',
        object_value: '85.7 billion USD',
      },
    ];
    const spacexObjects: ObjectSummary[] = [
      { uid: 'obj-1', class: 'organization', name: 'SpaceX', name_en: 'SpaceX', properties: {} },
      { uid: 'obj-2', class: 'organization', name: '골드만삭스', name_en: 'Goldman Sachs', properties: {} },
    ];
    const { rerender } = render(
      <FactCard
        fact={spacexFacts[0]!}
        objects={spacexObjects}
        action="accept"
        lang="kr"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('골드만삭스');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-2');
    rerender(
      <FactCard
        fact={spacexFacts[1]!}
        objects={spacexObjects}
        action="accept"
        lang="kr"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('SpaceX');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-1');
  });
});

describe('FactCard — UUID entity resolution (B-37)', () => {
  it('resolves a UUID subject_uid to the entity name when objects array carries it', () => {
    const onChange = vi.fn();
    const uuidObjects: ObjectSummary[] = [
      {
        uid: '6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f',
        class: 'organization',
        name: 'Found Fine Art',
        name_en: 'Found Fine Art',
        properties: {},
      },
    ];
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: '6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f',
    };
    render(
      <FactCard
        fact={fact}
        objects={uuidObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('Found Fine Art');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('6895dbc7');
  });

  it('flags an unresolved UUID with the same "(미해석)" marker as obj-N', () => {
    const onChange = vi.fn();
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: 'deadbeef-1234-5678-9abc-def012345678',
    };
    render(
      <FactCard
        fact={fact}
        objects={baseObjects}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(미해석)');
  });

  it('Edit subject input shows the resolved label as initial value when entity is known', () => {
    const onChange = vi.fn();
    const uuidObjects: ObjectSummary[] = [
      {
        uid: '11111111-2222-3333-4444-555555555555',
        class: 'organization',
        name: 'Other Entity',
        name_en: 'Other Entity',
        properties: {},
      },
    ];
    const presentUuid = '11111111-2222-3333-4444-555555555555';
    render(
      <FactCard
        fact={{ ...baseFact, subject_uid: presentUuid }}
        objects={uuidObjects}
        action="edit"
        editedSubjectUid={presentUuid}
        editedPredicate={baseFact.predicate!}
        editedObjectValue={baseFact.object_value!}
        lang="en"
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    // Input should show the human-readable label, not the raw UUID
    expect(input.value).toBe('Other Entity');
  });

  it('Edit subject input shows raw UUID when entity not in objects', () => {
    const onChange = vi.fn();
    const unknownUuid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    render(
      <FactCard
        fact={{ ...baseFact, subject_uid: unknownUuid }}
        objects={baseObjects}
        action="edit"
        editedSubjectUid={unknownUuid}
        editedPredicate="p"
        editedObjectValue="o"
        lang="kr"
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    // Shows the "(미해석)" resolved form
    expect(input.value).toMatch(/미해석|99999999/);
  });
});

describe('FactCard — discard toggle (spo-pending-ux)', () => {
  it('Discard button changes fact to discard state', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('Discard'));
    expect(onChange).toHaveBeenCalledWith({ action: 'discard' });
  });

  it('when discarded, button label becomes "취소"', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    expect(screen.getByText('취소')).toBeInTheDocument();
    expect(screen.queryByText('Discard')).toBeNull();
  });

  it('clicking "취소" when discarded reverts to accept', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('취소'));
    expect(onChange).toHaveBeenCalledWith({ action: 'accept' });
  });

  it('shows "폐기 예정" badge when discarded', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    expect(screen.getByText('폐기 예정')).toBeInTheDocument();
  });

  it('claim text has line-through when discarded', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    const claim = screen.getByText('AI will replace jobs.');
    expect(claim.className).toContain('line-through');
  });
});

describe('FactCard — edit-mode cancel (spo-pending-ux)', () => {
  it('shows "취소" cancel button in edit mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    // There should be a cancel button (취소) in edit mode
    const cancelButtons = screen.getAllByText('취소');
    expect(cancelButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking cancel in edit mode emits accept action', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const cancelButtons = screen.getAllByText('취소');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!);
    expect(onChange).toHaveBeenCalledWith({ action: 'accept' });
  });
});

describe('FactCard — edit-mode header (spo-pending-ux)', () => {
  it('shows original text as italic blockquote above inputs in edit mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const quote = screen.getByText(/AI will replace jobs\./);
    expect(quote.closest('blockquote')).not.toBeNull();
  });
});

describe('FactCard — subject chip click (spo-pending-ux)', () => {
  it('renders suggestion chips and chip click sets editedSubjectUid to entity_id', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-spacex', primary_label: 'SpaceX', primary_lang: 'en', score: 1.0 },
    ]);

    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'SpaceX' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-spacex')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('subject-chip-uuid-spacex'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedSubjectUid: 'uuid-spacex',
      }),
    );
  });
});

describe('FactCard — predicate autocomplete (spo-pending-ux)', () => {
  it('filters cached predicates and chip click sets editedPredicate', async () => {
    const onChange = vi.fn();
    (api.listPredicates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: 'plans', label_ko: '계획', label_en: 'plans' },
      { code: 'founded', label_ko: '설립', label_en: 'founded' },
    ]);

    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate=""
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );

    // Wait for predicates to load
    await waitFor(() => {
      expect(api.listPredicates).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByTestId('fact-edit-predicate-fn-1'), {
      target: { value: 'plan' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('predicate-chip-plans')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('predicate-chip-plans'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedPredicate: 'plans',
      }),
    );
  });
});